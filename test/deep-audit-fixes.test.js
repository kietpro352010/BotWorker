'use strict';

const assert = require('node:assert');
const EventEmitter = require('node:events');
const express = require('express');
const http = require('node:http');

const {
  MinecraftSession,
  applyCommandJitterMs,
  applyScheduleJitterMs,
  parseHhmmToMinutes
} = require('../src/game/minecraft-session');
const WorkerRuntime = require('../src/services/worker-runtime');
const WispbytePoller = require('../src/transports/wispbyte-poller');
const ManagerReporter = require('../src/transports/manager-reporter');
const ServerMonitor = require('../src/game/server-monitor');
const LobbyNavigator = require('../src/game/lobby-navigator');
const WorkerFleet = require('../src/services/worker-fleet');
const { redactAuditValue, isRestrictedMinecraftCommand } = require('../src/game/server-auth');
const { parseSocksProxy, assertPublicProxyHost } = require('../src/config/proxy');
const logger = require('../src/utils/logger');
const { createRouter } = require('../src/http/routes');

const quietLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function testW01NonLifecycleTimeoutPreservesSession() {
  console.log('1. [W-01] Testing non-lifecycle command timeout keeps real MinecraftSession alive...');
  const session = new MinecraftSession({
    workerId: 'w-w01',
    transport: 'wispbyte-poll',
    mc: { hosts: ['kingmc.vn'], port: 25565, username: 'AliveBot', password: 'pw' },
    afk: { mode: 'still' }
  }, quietLogger);

  const fakeBot = new EventEmitter();
  fakeBot.username = 'AliveBot';
  fakeBot.player = { ping: 20 };
  fakeBot._client = new EventEmitter();
  fakeBot._client.socket = new EventEmitter();
  fakeBot.quit = () => { throw new Error('Bot must NOT be quit on non-lifecycle command timeout'); };
  fakeBot.end = () => { throw new Error('Bot must NOT be ended on non-lifecycle command timeout'); };
  fakeBot.inventory = { slots: {}, items: () => [] };
  fakeBot.tossStack = () => new Promise((resolve) => setTimeout(resolve, 120));

  session.bot = fakeBot;
  session.state = 'online';
  session.manualStop = false;
  const genBefore = session.generation;

  // Give slot 36 an item so toss waits on slow tossStack
  fakeBot.inventory.slots[36] = { name: 'cobblestone', count: 1 };

  const runtime = new WorkerRuntime(session, {
    workerId: 'w-w01',
    commandTimeoutMs: 30
  }, quietLogger);

  await assert.rejects(() => runtime.execute('toss', { slot: 36 }), /timed out after 30ms/i);

  assert.strictEqual(session.state, 'online', 'Session must remain online after non-lifecycle timeout');
  assert.strictEqual(session.manualStop, false, 'manualStop must remain false');
  assert.strictEqual(session.bot, fakeBot, 'bot socket must remain attached');
  assert.strictEqual(session.generation, genBefore, 'generation must not be bumped');

  session.stop('test_cleanup', { emitEvent: false });
  console.log('✅ 1. [W-01] Real MinecraftSession stays online after non-lifecycle command timeout.');
}

async function testW02UpdateSlotBumpsInventoryRevision() {
  console.log('2. [W-02] Testing updateSlot bumps inventoryRevision (debounced) & emits state...');
  const session = new MinecraftSession({
    workerId: 'w-w02',
    transport: 'wispbyte-poll',
    mc: { hosts: ['kingmc.vn'], port: 25565, username: 'InvBot', password: '' },
    afk: { mode: 'still' }
  }, quietLogger);

  const fakeBot = new EventEmitter();
  fakeBot.username = 'InvBot';
  fakeBot.player = { ping: 20 };
  fakeBot._client = new EventEmitter();
  fakeBot.entity = { id: 1, position: { x: 100, y: 64, z: 100 } };
  fakeBot.inventory = new EventEmitter();
  fakeBot.inventory.slots = { 45: { name: 'totem_of_undying', count: 1 } };
  fakeBot.inventory.items = () => [];
  fakeBot.world = { getColumns: () => [] };

  session.bot = fakeBot;
  session.manualStop = false;
  session.generation = 1;
  session.state = 'online';

  let stateEmitted = 0;
  session.on('state', () => { stateEmitted += 1; });
  session.onSpawn(fakeBot, 1, 'kingmc.vn');
  const revBefore = session.inventoryRevision;
  const emittedBefore = stateEmitted;

  fakeBot.inventory.emit('updateSlot', 36);
  fakeBot.inventory.emit('updateSlot', 37);
  await sleep(420);

  assert.strictEqual(session.inventoryRevision, revBefore + 1, 'Debounced updateSlot must bump inventoryRevision once');
  assert.ok(stateEmitted > emittedBefore, 'Debounced updateSlot must emit state');

  session.stop('test_cleanup', { emitEvent: false });
  console.log('✅ 2. [W-02] Debounced updateSlot bumps inventoryRevision & emits state.');
}

async function testW03PollerAuthToleranceAndRecovery() {
  console.log('3. [W-03] Testing WispbytePoller tolerates transient 401/404 & recovers without suicide...');
  let pollAttempt = 0;
  let stopCalls = 0;
  let poller;

  const mockFetch = async () => {
    pollAttempt += 1;
    if (pollAttempt <= 2) {
      return { ok: false, status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) };
    }
    poller.stopping = true;
    poller.stopController.abort();
    return { ok: true, status: 200, json: async () => ({ ok: true, command: null }) };
  };

  poller = new WispbytePoller({
    config: { managerUrl: 'https://mgr.example.com', workerId: 'w-w03', secret: 's'.repeat(32) },
    runtime: {
      status: () => ({ state: 'online' }),
      execute: async (action) => { if (action === 'stop') stopCalls += 1; return { ok: true }; }
    },
    reporter: { managerLatencyMs: 10 },
    logger: quietLogger,
    fetchImpl: mockFetch,
    authFailureThreshold: 3,
    authBackoffScheduleMs: [10, 10, 10]
  });

  await poller.start();
  await poller.stop();

  assert.strictEqual(pollAttempt, 3, 'Poller must retry transient 401s and recover on attempt 3');
  assert.strictEqual(stopCalls, 0, 'Transient 401 below threshold must NOT stop bot');
  assert.strictEqual(poller.consecutiveAuthFailures, 0, 'Recovery must reset consecutiveAuthFailures');
  assert.strictEqual(poller.authPaused, false, 'Recovery must clear authPaused');

  // Test hitting threshold -> stops bot, sets authPaused=true, keeps probing (not stopping=true)
  let thresholdAttempts = 0;
  let thresholdStops = 0;
  let poller2;
  poller2 = new WispbytePoller({
    config: { managerUrl: 'https://mgr.example.com', workerId: 'w-w03-b', secret: 's'.repeat(32) },
    runtime: {
      status: () => ({ state: 'online' }),
      execute: async (action) => { if (action === 'stop') thresholdStops += 1; return { ok: true }; }
    },
    reporter: { managerLatencyMs: 10 },
    logger: quietLogger,
    fetchImpl: async () => {
      thresholdAttempts += 1;
      if (thresholdAttempts >= 3) {
        // After 3rd 401 hits threshold, abort cleanly on next sleep
        setTimeout(() => poller2.stop(), 5);
      }
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not_found' }) };
    },
    authFailureThreshold: 3,
    authBackoffScheduleMs: [5, 5, 50]
  });
  await poller2.start();
  assert.strictEqual(thresholdStops, 1, 'Bot must be stopped once threshold reached');
  assert.strictEqual(poller2.authPaused, true, 'authPaused must be true when threshold reached');

  // Verify WorkerFleet skips heartbeat when poller.authPaused is true
  const postedPaths = [];
  const origSetInterval = global.setInterval;
  const capturedIntervals = [];
  global.setInterval = (fn, ms, ...args) => {
    const h = origSetInterval(fn, ms, ...args);
    capturedIntervals.push({ fn, ms, h });
    return h;
  };
  let fleet;
  try {
    fleet = new WorkerFleet({
      transport: 'wispbyte-poll',
      autoStart: false,
      rssWarnMb: 440,
      wispbyte: { cookie: '', panelUrl: 'https://wispbyte.com/client', intervalMs: 86400000 },
      bots: [{
        slot: 1, workerId: 'w-w03-fleet', secret: 'f'.repeat(32),
        managerUrl: 'https://mgr.example.com', transport: 'wispbyte-poll',
        mc: { hosts: ['kingmc.vn'], port: 25565, version: '1.20.1', viewDistance: 'tiny', authType: 'offline' },
        afk: { mode: 'still', minMs: 180000, maxMs: 360000 }
      }]
    }, quietLogger, {
      fetchImpl: async (url) => {
        const pathname = new URL(url).pathname;
        postedPaths.push(pathname);
        if (pathname.endsWith('/bootstrap')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, settings: {}, credentials: { username: 'B', password: '' } }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });
    const inst = fleet.get('w-w03-fleet');
    inst.poller.start = () => Promise.resolve();
    inst.poller.stop = async () => { inst.poller.stopping = true; };
    await fleet.start();
    const hbEntry = capturedIntervals.find((i) => i.ms === 45000);
    const before = postedPaths.filter((p) => p.endsWith('/heartbeat')).length;
    inst.poller.failures = 3;
    inst.poller.authPaused = true;
    hbEntry.fn();
    await sleep(20);
    assert.strictEqual(postedPaths.filter((p) => p.endsWith('/heartbeat')).length, before, 'authPaused poller must NOT spam /heartbeat');
  } finally {
    global.setInterval = origSetInterval;
    if (fleet) await fleet.stop();
  }
  console.log('✅ 3. [W-03] WispbytePoller auth tolerance, recovery & fleet heartbeat guard verified.');
}

async function testW04SequenceGuardAndSignalIsolation() {
  console.log('4. [W-04] Testing ManagerReporter sequence guard & deferred heartbeat signal isolation...');
  let fetchCalls = 0;
  const reporter = new ManagerReporter({
    baseUrl: 'https://mgr.example.com',
    workerId: 'w-w04',
    secret: 's'.repeat(32),
    logger: quietLogger,
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        // First call observes caller 1's signal abort
        await sleep(30);
        if (init.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      }
      if (init.signal?.aborted) throw new Error('Second heartbeat must NOT inherit aborted signal');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });

  // 4a. Sequence guard: stale prepare (seq 1) must not overwrite newer record (seq 2)
  const staleMeta = reporter.prepareStatusPayload({ state: 'entering', position: { x: 0, y: 64, z: 0 } });
  const freshMeta = reporter.prepareStatusPayload({ state: 'online', position: { x: 100, y: 64, z: 100 } });
  reporter.recordStatusSent(freshMeta);
  const digestAfterFresh = reporter.lastStateDigest;
  const posAfterFresh = { ...reporter.lastReportedPosition };
  reporter.recordStatusSent(staleMeta);
  assert.strictEqual(reporter.lastStateDigest, digestAfterFresh, 'Stale seq must not overwrite lastStateDigest');
  assert.deepStrictEqual(reporter.lastReportedPosition, posAfterFresh, 'Stale seq must not overwrite lastReportedPosition');

  // 4b. Deferred heartbeat drain must NOT inherit aborted signal from caller 1
  const ac = new AbortController();
  const p1 = reporter.heartbeat({ state: 'connecting' }, { signal: ac.signal }).catch(() => {});
  reporter.pendingHeartbeat = { state: 'online' };
  ac.abort();
  await p1;
  await sleep(40);
  assert.ok(fetchCalls >= 2, 'Queued pending heartbeat must flush cleanly with fresh signal after caller 1 aborts');
  console.log('✅ 4. [W-04] Sequence guard & deferred heartbeat signal isolation verified.');
}

async function testW05EmptyBotPasswordAllowed() {
  console.log('5. [W-05] Testing empty bot password accepted even with authEnabled=true...');
  const session = new MinecraftSession({
    workerId: 'w-w05',
    transport: 'wispbyte-poll',
    authEnabled: true,
    mc: { hosts: ['kingmc.vn'], port: 25565, username: 'OfflineNoPass', password: '' },
    afk: { mode: 'still' }
  }, quietLogger);
  assert.strictEqual(session.hasCredentials(), true, 'hasCredentials must accept username with empty password');
  assert.strictEqual(session.applyManagerCredentials({ username: 'NoPassUser', password: '' }), true);
  assert.strictEqual(session.username, 'NoPassUser');
  assert.strictEqual(session.password, '');
  session.stop('test_cleanup', { emitEvent: false });
  console.log('✅ 5. [W-05] Empty bot password accepted with authEnabled=true.');
}

async function testW06TpsPreservedAndOffhandCounting() {
  console.log('6. [W-06] Testing TPS preserved when physics disabled & off-hand golden apple/food counting...');
  const monitor = new ServerMonitor({ sampleMs: 40 });
  const fakeBot = new EventEmitter();
  fakeBot.time = { age: 100 };
  fakeBot.player = { ping: 30 };
  fakeBot.inventory = {
    items: () => [],
    slots: { 45: { name: 'enchanted_golden_apple', count: 5 } }
  };
  monitor.attach(fakeBot);
  monitor.lastTimeAt = Date.now() - 1000;
  fakeBot.time.age = 119;
  fakeBot.emit('time');
  assert.strictEqual(monitor.tps, 19, 'ServerMonitor must compute TPS from server time');

  // Even if physicsTick never fires (eco physics disabled), timer must NOT overwrite real server TPS
  await sleep(70);
  assert.strictEqual(monitor.tps, 19, 'ServerMonitor timer must preserve server TPS when lastTimeAge is known');
  const snap = monitor.snapshot();
  assert.strictEqual(snap.goldenAppleCount, 5, 'ServerMonitor must count off-hand enchanted_golden_apple');
  monitor.detach();

  // Check MinecraftSession.getInventorySnapshot counts off-hand golden_apple & food
  const session = new MinecraftSession({
    workerId: 'w-w06',
    transport: 'wispbyte-poll',
    mc: { hosts: ['kingmc.vn'], port: 25565, username: 'OffhandBot', password: '' },
    afk: { mode: 'still' }
  }, quietLogger);
  session.bot = {
    inventory: { slots: { 45: { name: 'golden_apple', count: 3 } } },
    health: 20, food: 20, quickBarSlot: 0
  };
  const inv = session.getInventorySnapshot();
  assert.strictEqual(inv.goldenAppleCount, 3, 'getInventorySnapshot must count off-hand golden_apple');
  assert.strictEqual(inv.foodCount, 3, 'getInventorySnapshot must count off-hand food');
  session.stop('test_cleanup', { emitEvent: false });
  console.log('✅ 6. [W-06] TPS preservation & off-hand slot 45 counting verified.');
}

async function testSec04AndSec06Hardening() {
  console.log('7. [SEC-04/SEC-06] Testing proxy decode safety, DNS private block, redaction & diagnostics previousSecret...');
  // Bad percent encoding in proxy URL -> clean Error (not URIError)
  assert.throws(
    () => parseSocksProxy('socks5://bad%ZZuser:pass@1.2.3.4:1080'),
    /invalid percent-encoding/i
  );
  // Private host rejected by assertPublicProxyHost
  await assert.rejects(() => assertPublicProxyHost('127.0.0.1'), /local or private/i);
  await assert.rejects(() => assertPublicProxyHost('localhost'), /local or private/i);

  // Redaction covers /l, /reg, namespaced /authme:login, and passwords with spaces
  assert.strictEqual(redactAuditValue('/l my secret pass 123'), '/l *** REDACTED ***');
  assert.strictEqual(redactAuditValue('/reg pass one pass one'), '/reg *** REDACTED ***');
  assert.strictEqual(redactAuditValue('/authme:login top secret'), '/authme:login *** REDACTED ***');
  assert.strictEqual(isRestrictedMinecraftCommand('/l abc'), true);
  assert.strictEqual(isRestrictedMinecraftCommand('/reg abc abc'), true);

  // Logger redacts URL credentials inside Error objects
  const errLines = [];
  const origErr = console.error;
  console.error = (line) => errLines.push(line);
  try {
    logger.error('proxy_err', {
      err: new Error('connect failed socks5://alice:s3cr3tPass@1.2.3.4:1080 and https://bob:p4ss@host.io')
    });
  } finally {
    console.error = origErr;
  }
  assert.strictEqual(errLines.length, 1);
  assert.ok(!errLines[0].includes('s3cr3tPass'), 'Error message URL password must be redacted');
  assert.ok(!errLines[0].includes('p4ss'), 'Multiple URL passwords in Error must be redacted');

  // /api/v1/diagnostics accepts previousSecret during grace period
  const app = express();
  app.use(express.json());
  const oldSecret = 'o'.repeat(32);
  const newSecret = 'n'.repeat(32);
  app.use(createRouter({
    fleet: { health: () => ({ botCount: 1 }), get: () => null, list: () => [] },
    config: {
      botCount: 1,
      bots: [{ workerId: 'w-rot', slot: 1, secret: newSecret, previousSecret: oldSecret, graceUntil: Date.now() + 60000 }]
    }
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const resOld = await fetch(`http://127.0.0.1:${port}/api/v1/diagnostics`, {
      headers: { 'x-worker-secret': oldSecret }
    });
    assert.strictEqual(resOld.status, 200, 'Diagnostics must accept previousSecret within grace period');
    const resBad = await fetch(`http://127.0.0.1:${port}/api/v1/diagnostics`, {
      headers: { 'x-worker-secret': 'x'.repeat(32) }
    });
    assert.strictEqual(resBad.status, 401);
  } finally {
    server.close();
  }
  console.log('✅ 7. [SEC-04/SEC-06] Proxy, redaction, logger Error sanitization & diagnostics grace secret verified.');
}

async function testW08LiveSettingsAndAutomation() {
  console.log('8. [W-08] Testing applyManagerSettings (autoTotem, antiHungry, autoReconnect, antiAfkKick, spawnCommands, schedules) & settingsRevision...');
  const session = new MinecraftSession({
    workerId: 'w-w08',
    transport: 'wispbyte-poll',
    autoReconnect: true,
    mc: { hosts: ['kingmc.vn'], port: 25565, username: 'AutoBot', password: '' },
    afk: { mode: 'still' }
  }, quietLogger);

  let equippedItem = null;
  let consumed = false;
  const chatted = [];
  const fakeBot = {
    username: 'AutoBot',
    health: 18,
    food: 10,
    inventory: {
      slots: {},
      items: () => [
        { name: 'totem_of_undying', count: 1 },
        { name: 'cooked_beef', count: 4 }
      ]
    },
    equip: async (item) => { equippedItem = item.name; },
    consume: async () => { consumed = true; },
    chat: (msg) => { chatted.push(msg); }
  };
  session.bot = fakeBot;
  session.state = 'online';
  session.manualStop = false;

  // 1. autoTotem=false prevents fastEquipTotem
  session.applyManagerSettings({ autoTotem: false, antiHungry: false, autoReconnect: false });
  await session.fastEquipTotem(fakeBot);
  assert.strictEqual(equippedItem, null, 'autoTotem=false must skip fastEquipTotem');

  // 2. Enabling autoTotem & antiHungry triggers immediate equip & eat
  session.applyManagerSettings({ autoTotem: true });
  await sleep(10);
  assert.strictEqual(equippedItem, 'totem_of_undying', 'Enabling autoTotem must equip totem');

  session.applyManagerSettings({ antiHungry: true });
  await sleep(15);
  assert.strictEqual(consumed, true, 'Enabling antiHungry when food < 16 must consume food');

  // 3. dispatchScheduledMessages filters restricted auth commands & sends valid chat
  session.dispatchScheduledMessages(fakeBot, session.generation, ['/login secret', 'Hello KingMC'], 0);
  assert.deepStrictEqual(chatted, ['Hello KingMC']);

  // 4. ManagerReporter.noteSettingsRevision triggers onSettingsChanged when revision advances
  let refreshedRev = null;
  const reporter = new ManagerReporter({
    baseUrl: 'https://manager.example.com',
    workerId: 'w-w08',
    secret: 's'.repeat(32),
    logger: quietLogger,
    onSettingsChanged: (rev) => { refreshedRev = rev; }
  });
  reporter.noteSettingsRevision(1);
  assert.strictEqual(refreshedRev, null);
  reporter.noteSettingsRevision(2);
  await sleep(10);
  assert.strictEqual(refreshedRev, 2, 'Advancing settingsRevision must trigger onSettingsChanged');

  session.stop('test_cleanup', { emitEvent: false });
  console.log('✅ 8. [W-08] Live settings, antiHungry, autoTotem, scheduled chat & settingsRevision verified.');
}

async function testW09AfkAlertsAndAntiCheatJitter() {
  console.log('9. [W-09] Testing AFK kick/recovery/reconnect_exhausted events & anti-cheat jitter (±5s commands, ±15m schedules)...');

  // 1. Verify ±5s command jitter & ±15m schedule jitter bounds
  for (let i = 0; i < 30; i++) {
    const cmdDelay = applyCommandJitterMs(6000, 5000, 800);
    assert.ok(cmdDelay >= 1000 && cmdDelay <= 11000, `Command jitter must stay within ±5s, got ${cmdDelay}`);
    const schedDelay = applyScheduleJitterMs(120, 15, 60000);
    assert.ok(schedDelay >= 105 * 60000 && schedDelay <= 135 * 60000, `Schedule jitter must stay within ±15m, got ${schedDelay}`);
  }

  const session = new MinecraftSession({
    workerId: 'w-w09',
    transport: 'wispbyte-poll',
    autoReconnect: true,
    reconnectBaseMs: 1000,
    reconnectMaxMs: 10000,
    reconnectMaxAttempts: 3,
    mc: { hosts: ['kingmc.vn'], port: 25565, username: 'AntiCheatBot', password: '' },
    afk: { mode: 'still' }
  }, quietLogger);

  // Verify fixed schedule daily ±15m jitter
  const effectiveHhmm = session.resolveDailyJitteredHhmm('sched-on', '12:00', '2026-11-19', 600);
  const effectiveMin = parseHhmmToMinutes(effectiveHhmm);
  assert.ok(effectiveMin >= 705 && effectiveMin <= 735, `Fixed schedule 12:00 must jitter within 11:45..12:15, got ${effectiveHhmm}`);

  const emittedEvents = [];
  session.on('event', (ev) => emittedEvents.push(ev));

  // 2. Kick while NOT in AFK (e.g. connecting / lobby) must NOT emit afk_kicked
  const lobbyBot = {
    username: 'AntiCheatBot',
    entity: { position: { x: 1, y: 41, z: 1 } },
    quit: () => {},
    end: () => {}
  };
  session.bot = lobbyBot;
  session.generation = 1;
  session.manualStop = false;
  session.state = 'entering';
  session.isInAfkState = false;
  session.onKicked(lobbyBot, 1, 'Lobby full');
  if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
  assert.strictEqual(emittedEvents.some((e) => e.type === 'afk_kicked'), false, 'Kick outside AFK state must NOT emit afk_kicked');

  // 3. Entering AFK state -> getting kicked MUST emit afk_kicked
  const afkBot = {
    username: 'AntiCheatBot',
    entity: { position: { x: 500, y: 70, z: -300 } },
    quit: () => {},
    end: () => {}
  };
  session.bot = afkBot;
  session.generation = 2;
  session.state = 'online';
  session.isInAfkState = true;
  session.reconnectAttempts = 0;
  session.onKicked(afkBot, 2, 'Server restart');
  if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
  assert.strictEqual(emittedEvents.filter((e) => e.type === 'afk_kicked').length, 1, 'Kick while in AFK must emit afk_kicked');
  assert.strictEqual(session.wasAfkBeforeDisconnect, true);

  // 4. Intermediate failed reconnect must NOT emit duplicate afk_kicked
  const retryFailBot = {
    username: 'AntiCheatBot',
    entity: { position: { x: 1, y: 41, z: 1 } },
    quit: () => {},
    end: () => {}
  };
  session.bot = retryFailBot;
  session.generation = 3;
  session.state = 'connecting';
  session.onEnd(retryFailBot, 3);
  if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
  assert.strictEqual(emittedEvents.filter((e) => e.type === 'afk_kicked').length, 1, 'Intermediate reconnect failure must NOT emit another afk_kicked');
  assert.strictEqual(session.wasAfkBeforeDisconnect, true, 'wasAfkBeforeDisconnect must be preserved until AFK recovery or exhaustion');

  // 5. Successful return to AFK world emits afk_recovered
  const recoveredBot = {
    username: 'AntiCheatBot',
    entity: { position: { x: 500, y: 70, z: -300 } },
    food: 20,
    quit: () => {},
    end: () => {}
  };
  session.bot = recoveredBot;
  session.generation = 4;
  session.state = 'entering';
  session.startLocationMonitor(recoveredBot, 4, 'kingmc.vn');
  await sleep(900);
  assert.strictEqual(emittedEvents.some((e) => e.type === 'afk_recovered'), true, 'Re-entering AFK world after AFK drop must emit afk_recovered');
  assert.strictEqual(session.isInAfkState, true);
  assert.strictEqual(session.wasAfkBeforeDisconnect, false);

  // 6. Exhausting maxReconnectAttempts stops reconnecting and emits reconnect_exhausted
  session.reconnectAttempts = 3; // equals reconnectMaxAttempts=3
  session.state = 'error';
  session.scheduleReconnect();
  assert.strictEqual(session.manualStop, true, 'Exhausting reconnect limit must stop reconnecting');
  assert.strictEqual(emittedEvents.some((e) => e.type === 'reconnect_exhausted'), true, 'Exhausting reconnect limit must emit reconnect_exhausted');

  session.stop('test_cleanup', { emitEvent: false });
  console.log('✅ 9. [W-09] AFK lifecycle alerts (afk_kicked, afk_recovered, reconnect_exhausted) & anti-cheat jitter verified.');
}

async function testW10UltraDeepAuditFixes() {
  console.log('10. [W-10] Testing ServerMonitor world-switch TPS, Poller batch preserve, Reporter retry/stop, LobbyNavigator cleanup & midnight jitter clamp...');

  // 10.1 ServerMonitor recovers TPS after world age drops (lobby -> survival switch)
  const monitor = new ServerMonitor({ sampleMs: 60000 });
  const fakeBot = new EventEmitter();
  fakeBot.time = { age: 100000 };
  monitor.attach(fakeBot);
  monitor.lastTimeAt = Date.now() - 2000;
  fakeBot.time.age = 100040;
  monitor.onServerTime();
  assert.strictEqual(monitor.tps, 20, 'Initial TPS should compute to 20');

  // Switch server -> world age resets to 50 (negative deltaTicks)
  fakeBot.time.age = 50;
  monitor.lastTimeAt = Date.now() - 1000;
  monitor.onServerTime();
  assert.strictEqual(monitor.lastTimeAge, 50, 'Negative deltaTicks must reset lastTimeAge instead of freezing TPS');

  // Next tick in new world updates TPS normally (10 ticks in 1s -> 10 TPS)
  monitor.lastTimeAt = Date.now() - 1000;
  fakeBot.time.age = 60;
  monitor.onServerTime();
  assert.ok(monitor.tps >= 9 && monitor.tps <= 11, `TPS must recover after world switch (got ${monitor.tps})`);
  monitor.detach();

  // 10.2 WispbytePoller._flushPendingResults preserves ALL remaining items after 401 break
  const poller = new WispbytePoller({
    config: { workerId: 'w-poller-batch', managerUrl: 'https://manager.test', secret: 'secret_12345678901234567890123456789012' },
    runtime: { execute: async () => ({ ok: true }) },
    reporter: null,
    logger: quietLogger,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, error: 'unauthorized' })
    })
  });
  poller.pendingResults = [
    { payload: { commandId: 'cmd-1' }, attempts: 0, nextRetryAt: 0 },
    { payload: { commandId: 'cmd-2' }, attempts: 0, nextRetryAt: 0 },
    { payload: { commandId: 'cmd-3' }, attempts: 0, nextRetryAt: 0 }
  ];
  await poller.flushPendingResults();
  assert.deepStrictEqual(
    poller.pendingResults.map((x) => x.payload.commandId),
    ['cmd-1', 'cmd-2', 'cmd-3'],
    '401 break must preserve ALL remaining items in pendingResults'
  );
  poller.stop();

  // 10.3 ManagerReporter.noteSettingsRevision retries after transient failure & stop() prevents rescheduling
  let refreshAttempts = 0;
  const reporter = new ManagerReporter({
    baseUrl: 'https://manager.test',
    workerId: 'w-rep-rev',
    secret: 'secret_12345678901234567890123456789012',
    logger: quietLogger,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    onSettingsChanged: async () => {
      refreshAttempts += 1;
      if (refreshAttempts === 1) throw new Error('transient_network_blip');
    }
  });
  reporter.noteSettingsRevision(1);
  assert.strictEqual(reporter.lastSettingsRevision, 1);
  reporter.noteSettingsRevision(2);
  await sleep(30);
  assert.strictEqual(refreshAttempts, 1);
  assert.strictEqual(reporter.lastSettingsRevision, 1, 'Failed refresh must NOT advance lastSettingsRevision');
  reporter.noteSettingsRevision(2);
  await sleep(30);
  assert.strictEqual(refreshAttempts, 2, 'Next poll/heartbeat must retry settings refresh');
  assert.strictEqual(reporter.lastSettingsRevision, 2, 'Successful refresh must advance lastSettingsRevision');

  reporter.stop();
  const resAfterStop = await reporter.sendHeartbeat({ state: 'online' });
  assert.strictEqual(resAfterStop, undefined);
  assert.strictEqual(reporter.lastStateDigest, null, 'Early-returned post() after stop must NOT mutate lastStateDigest');
  reporter.enqueueEvent({ type: 'info', message: 'after stop' });
  assert.strictEqual(reporter.eventFlushTimer, null, 'enqueueEvent after stop() must NOT schedule a flush timer');

  // 10.4 LobbyNavigator clears pendingMenuListener & sets lastExhaustedAt on retry exhaustion
  const nav = new LobbyNavigator({ logger: quietLogger, isAuthenticated: () => true });
  const navBot = new EventEmitter();
  navBot.entity = { position: { x: 1, y: 41, z: 1 } };
  navBot.inventory = { slots: [], items: () => [] };
  navBot.chat = () => {};
  navBot.activateItem = () => {};
  nav.bot = navBot;
  nav.serverJoinAttempts = 2; // next call makes it 3 (exhausted)
  nav.triggerServerJoin(navBot, 'test_exhaust');
  assert.ok(nav.pendingMenuListener, 'Menu listener attached initially');
  assert.strictEqual(navBot.listenerCount('windowOpen'), 1);
  await sleep(3650);
  assert.strictEqual(nav.pendingMenuListener, null, 'Exhausted retryTimer must clear pendingMenuListener immediately');
  assert.strictEqual(navBot.listenerCount('windowOpen'), 0, 'windowOpen listener must be removed on exhaustion');
  assert.ok(nav.lastExhaustedAt > 0, 'Exhaustion must set lastExhaustedAt');
  nav.clear();

  // 10.5 MinecraftSession midnight jitter clamping + resetData AFK flags + schedule cache reset
  const session = new MinecraftSession({
    workerId: 'w-jitter-clamp',
    transport: 'wispbyte-poll',
    mc: { hosts: ['kingmc.vn'], port: 25565, username: 'ClampBot', password: 'pw' },
    afk: { mode: 'still' }
  }, quietLogger);
  for (let i = 0; i < 60; i++) {
    session.botScheduleDailyJitter.clear();
    const early = session.resolveDailyJitteredHhmm(`early-${i}`, '00:05', '2026-11-19', 0);
    const earlyMin = parseHhmmToMinutes(early);
    assert.ok(earlyMin >= 0 && earlyMin <= 20, `00:05 jitter must NOT wrap to previous night (got ${early})`);

    const late = session.resolveDailyJitteredHhmm(`late-${i}`, '23:55', '2026-11-19', 100);
    const lateMin = parseHhmmToMinutes(late);
    assert.ok(lateMin >= 23 * 60 + 40 && lateMin <= 23 * 60 + 59, `23:55 jitter must NOT wrap past midnight (got ${late})`);
  }
  session.isInAfkState = true;
  session.wasAfkBeforeDisconnect = true;
  session.lastReconnectAttemptCount = 4;
  await session.resetData();
  assert.strictEqual(session.isInAfkState, false);
  assert.strictEqual(session.wasAfkBeforeDisconnect, false);
  assert.strictEqual(session.lastReconnectAttemptCount, 0);

  session.autoChatNextIntervalAt.set('s1', Date.now() + 99999);
  session.applyManagerSettings({ autoChatSchedules: [{ id: 's1', enabled: true, mode: 'interval', intervalSeconds: 30, messages: ['hi'] }] });
  assert.strictEqual(session.autoChatNextIntervalAt.size, 0, 'Updating autoChatSchedules must clear stale nextIntervalAt cache');
  session.stop('test_cleanup', { emitEvent: false });

  console.log('✅ 10. [W-10] ServerMonitor TPS recovery, Poller batch preservation, Reporter retry/stop, Navigator cleanup & midnight jitter clamp verified.');
}

async function testW11Round3AdversarialAuditFixes() {
  console.log('11. [W-11] Testing Round-3 Worker fixes (cleanup order/blockAt, SOCKS5 end+IPv6 SSRF, LobbyNavigator, maintenance/resetData, GUI totem guard, packet entityId=0, HTTP abort 504)...');

  const { isLocalOrPrivateHost, createSocksConnector } = require('../src/config/proxy');
  const { attachEarlyPacketDropFilter } = require('../src/game/packet-optimization');

  // 11a. cleanupSessionResources triggers internal 'end' listeners BEFORE removeAllListeners & keeps bot.blockAt callable
  const session = new MinecraftSession({
    workerId: 'bot-r3-1',
    transport: 'http',
    mc: { hosts: ['mc.kingmc.vn'], port: 25565, version: '1.20.1', username: 'testbot', password: '' },
    autoReconnect: true,
    reconnectBaseMs: 5000,
    reconnectMaxMs: 60000,
    connectTimeoutMs: 5000
  }, quietLogger);

  const fakeBot = new EventEmitter();
  const fakeClient = new EventEmitter();
  let physicsCleared = false;
  let keepaliveCleared = false;
  fakeBot.once('end', () => { physicsCleared = true; });
  fakeClient.once('end', () => { keepaliveCleared = true; });
  fakeBot._client = fakeClient;
  fakeBot.quit = () => {};
  fakeBot.blockAt = () => ({ name: 'stone' });
  fakeBot.players = { testbot: { uuid: 'u-self' }, other: { uuid: 'u-other' } };
  fakeBot.uuidToUsername = { 'u-self': 'testbot', 'u-other': 'other' };
  fakeBot.player = { uuid: 'u-self' };
  fakeBot.username = 'testbot';
  fakeBot.entities = { 1: { id: 1 }, 2: { id: 2 } };
  fakeBot.entity = fakeBot.entities[1];

  session.bot = fakeBot;
  session.pruneMemory();
  assert.strictEqual(fakeBot.players.other, undefined, 'pruneMemory must remove other players');
  assert.strictEqual(fakeBot.uuidToUsername['u-other'], undefined, 'pruneMemory must remove orphaned uuidToUsername entries');
  assert.strictEqual(fakeBot.uuidToUsername['u-self'], 'testbot', 'pruneMemory must preserve own uuidToUsername entry');

  session.cleanupSessionResources(fakeBot);
  assert.strictEqual(physicsCleared, true, 'cleanupSessionResources must emit/trigger internal bot end listener before removeAllListeners');
  assert.strictEqual(keepaliveCleared, true, 'cleanupSessionResources must trigger internal client end listener before removeAllListeners');
  assert.strictEqual(typeof fakeBot.blockAt, 'function', 'bot.blockAt must remain a safe callable no-op after cleanup');
  assert.strictEqual(fakeBot.blockAt(), null, 'bot.blockAt() no-op must return null');

  // 11b. fastEquipTotem & tryEatFood skip when container GUI window is open or eating
  let equipCalled = false;
  const guiBot = {
    currentWindow: { id: 1, title: 'Menu' },
    inventory: {
      slots: {},
      items: () => [{ name: 'totem_of_undying' }, { name: 'cooked_beef' }]
    },
    food: 10,
    health: 20,
    equip: async () => { equipCalled = true; },
    consume: async () => { equipCalled = true; }
  };
  session.state = 'online';
  await session.fastEquipTotem(guiBot);
  await session.tryEatFood(guiBot);
  assert.strictEqual(equipCalled, false, 'fastEquipTotem and tryEatFood must NOT touch inventory while bot.currentWindow is open');

  guiBot.currentWindow = null;
  session.isEatingFood = true;
  await session.fastEquipTotem(guiBot);
  assert.strictEqual(equipCalled, false, 'fastEquipTotem must NOT run concurrently while isEatingFood is true');
  session.isEatingFood = false;

  // 11c. resetData clears botSchedules/autoChatSchedules/spawnCommands & stops botScheduleTimer; enterMaintenanceWindow bumps generation
  session.applyManagerSettings({
    spawnCommands: '/hub',
    autoChatSchedules: [{ id: 'ac1', enabled: true, mode: 'interval', intervalSeconds: 60, messages: ['hi'] }],
    botSchedules: [{ id: 'bs1', enabled: true, mode: 'fixed', items: [{ id: 'i1', action: 'stop', time: '04:30' }] }]
  });
  assert.ok(session.botScheduleTimer, 'botScheduleTimer must be active when schedule configured');
  const genBeforeMaint = session.generation;
  session.manualStop = false;
  session.enterMaintenanceWindow();
  assert.ok(session.generation > genBeforeMaint, 'enterMaintenanceWindow must increment session.generation');

  await session.resetData();
  assert.strictEqual(session.botScheduleTimer, null, 'resetData must stop botScheduleTimer');
  assert.strictEqual(session.botSchedules.length, 0, 'resetData must clear botSchedules');
  assert.strictEqual(session.autoChatSchedules.length, 0, 'resetData must clear autoChatSchedules');
  assert.strictEqual(session.spawnCommands, '', 'resetData must clear spawnCommands');

  // 11d. stop('process_shutdown') stops botScheduleTimer
  session.applyManagerSettings({
    botSchedules: [{ id: 'bs2', enabled: true, mode: 'fixed', items: [{ id: 'i2', action: 'start', time: '05:30' }] }]
  });
  assert.ok(session.botScheduleTimer);
  await session.stop('process_shutdown', { emitEvent: false });
  assert.strictEqual(session.botScheduleTimer, null, 'stop(process_shutdown) must clear botScheduleTimer');

  // 11e. IPv6 canonical SSRF blocking & createSocksConnector emits both error and end on failure
  const blockedHosts = [
    '0:0:0:0:0:0:0:1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::127.0.0.1',
    '64:ff9b::169.254.169.254',
    '2002:7f00:0001::',
    'fec0::1',
    '2001:db8::1',
    '100::1'
  ];
  for (const h of blockedHosts) {
    assert.strictEqual(isLocalOrPrivateHost(h), true, `Expected IPv6 host ${h} to be blocked`);
  }
  assert.strictEqual(isLocalOrPrivateHost('2606:4700:4700::1111'), false, 'Public IPv6 must remain allowed');

  const socksClientMock = new EventEmitter();
  let socksErrCount = 0;
  let socksEndCount = 0;
  socksClientMock.on('error', () => { socksErrCount += 1; });
  socksClientMock.on('end', () => { socksEndCount += 1; });
  const connector = createSocksConnector({ host: '127.0.0.1', port: 1080 }, 'mc.kingmc.vn', 25565, { timeoutMs: 1000, logger: quietLogger });
  connector(socksClientMock);
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(socksErrCount, 1, 'createSocksConnector must emit error on blocked proxy');
  assert.strictEqual(socksEndCount, 1, 'createSocksConnector must ALSO emit end on failure to avoid connecting deadlock');

  // 11f. LobbyNavigator lastExhaustedAt === 0 & triggerServerJoin after clear()
  const nav = new LobbyNavigator({ logger: quietLogger, isAuthenticated: () => true });
  const navBot = new EventEmitter();
  navBot.entity = { position: { x: 0.5, y: 41.0, z: 0.8 } };
  navBot.inventory = { slots: {} };
  navBot.chat = () => {};
  navBot.activateItem = () => {};
  navBot.setQuickBarSlot = () => {};
  nav.serverJoinAttempts = 2;
  nav.lastExhaustedAt = 0;
  nav.tryJoin(navBot);
  assert.strictEqual(nav.serverJoinAttempts, 3, 'tryJoin must NOT reset serverJoinAttempts when lastExhaustedAt === 0');
  nav.clear();
  assert.strictEqual(nav.bot, null);
  nav.triggerServerJoin(navBot, 'test_after_clear');
  assert.strictEqual(nav.bot, navBot, 'triggerServerJoin must re-bind this.bot after clear()');
  nav.clear();

  // 11g. packet-optimization handles entity.id === 0 and set_passengers vehicle ID
  const pktBot = new EventEmitter();
  pktBot.entity = { id: 0 };
  pktBot._client = new EventEmitter();
  pktBot.entities = { 0: pktBot.entity };
  attachEarlyPacketDropFilter(pktBot);
  let statusReceived = false;
  let passengersReceived = false;
  pktBot._client.on('entity_status', () => { statusReceived = true; });
  pktBot._client.on('set_passengers', () => { passengersReceived = true; });
  pktBot._client.emit('entity_status', { entityId: 0, entityStatus: 35 });
  pktBot._client.emit('set_passengers', { entityId: 999, passengers: [0] });
  assert.strictEqual(statusReceived, true, 'entity_status for bot entityId === 0 must NOT be dropped');
  assert.strictEqual(passengersReceived, true, 'set_passengers containing bot entityId in passengers[] must NOT be dropped');
  pktBot.emit('end');

  // 11h. HTTP route /command maps internal "aborted" error to 504 when client is still connected
  const app = express();
  app.use(express.json());
  const mockFleet = {
    get: () => ({
      config: { workerId: 'w-abort', secret: 's'.repeat(32) },
      runtime: {
        status: () => ({ state: 'online' }),
        execute: async () => {
          const e = new Error('This operation was aborted');
          e.name = 'AbortError';
          throw e;
        }
      }
    }),
    list: () => [],
    health: () => ({})
  };
  app.use(createRouter({ fleet: mockFleet, config: { botCount: 1, bots: [{ workerId: 'w-abort', secret: 's'.repeat(32) }] } }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, r));
  try {
    const port = srv.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/bots/w-abort/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worker-secret': 's'.repeat(32) },
      body: JSON.stringify({ action: 'status', payload: {} }),
      signal: AbortSignal.timeout(3000)
    });
    const body = await res.json();
    assert.strictEqual(res.status, 504, 'Internal fetch/operation aborted error must return HTTP 504 instead of hanging');
    assert.strictEqual(body.ok, false);
  } finally {
    await new Promise((r) => srv.close(r));
  }

  console.log('✅ 11. [W-11] Round-3 adversarial worker fixes verified 100%.');
}

async function testW12Round4IndependentAuditFixes() {
  console.log('12. [W-12] Testing Round-4 Worker fixes (AFK/dimension state digest, inventory/window validation, resetData proxy+connectedAt, malformed proxy resilience, Reporter reset & DAG, Poller afk idle, KeepAlive credentials)...');

  const { normalizeState, computeBotStateDigest } = require('../src/domain/worker-state');
  const { extractChatMessage } = require('../src/game/server-auth');
  const AfkController = require('../src/game/afk-controller');
  const WispbyteKeepAlive = require('../src/services/wispbyte-keepalive');

  // 12a. worker-state recognizes afk/afk_locked & digest tracks dimension changes
  assert.strictEqual(normalizeState('afk'), 'afk');
  assert.strictEqual(normalizeState('afk_locked'), 'afk_locked');
  const dOverworld = computeBotStateDigest({ state: 'afk', dimension: 'minecraft:overworld', health: 20, food: 20 });
  const dNether = computeBotStateDigest({ state: 'afk', dimension: 'minecraft:the_nether', health: 20, food: 20 });
  assert.notStrictEqual(dOverworld, dNether, 'computeBotStateDigest must reflect dimension changes');

  // 12b. server-auth extractChatMessage caps deeply nested JSON without stack overflow
  let nested = { text: 'leaf' };
  for (let i = 0; i < 60; i++) nested = { extra: [nested] };
  assert.strictEqual(extractChatMessage(nested), '', 'Deeply nested chat JSON beyond depth 32 must terminate safely');

  // 12c. AfkController skips micro-look/swing when bot.currentWindow is open
  let lookCalled = false;
  const afkCtrl = new AfkController({ logger: quietLogger });
  afkCtrl.bot = {
    entity: { yaw: 0, pitch: 0 },
    currentWindow: { id: 2 },
    look: () => { lookCalled = true; },
    swingArm: () => { lookCalled = true; }
  };
  afkCtrl.active = true;
  afkCtrl.performMicroLookAndSwing();
  assert.strictEqual(lookCalled, false, 'AfkController must skip micro-look/swing while GUI window is open');
  afkCtrl.stop();

  // 12d. MinecraftSession inventory/window validation, resetData clears proxy+connectedAt, malformed proxyUrl resilience
  const session = new MinecraftSession({
    workerId: 'bot-r4-1',
    transport: 'wispbyte-poll',
    mc: { hosts: ['kingmc.vn'], port: 25565, version: '1.20.1', username: 'R4Bot', password: '' }
  }, quietLogger);
  session.applyManagerSettings({ proxyUrl: 'http://invalid-legacy-proxy:8080', ecoMode: false });
  assert.strictEqual(session.proxy, null, 'Malformed proxyUrl in applyManagerSettings must degrade to null instead of throwing');
  assert.strictEqual(session.ecoMode, false, 'Settings after malformed proxyUrl must still apply');

  session.state = 'online';
  session.connectedAt = Date.now() - 5000;
  session.proxy = { host: '8.8.8.8', port: 1080 };
  const fakeBot = new EventEmitter();
  fakeBot._client = new EventEmitter();
  fakeBot.inventory = { slots: { 36: { name: 'stone', count: 1 } }, items: () => [{ name: 'stone', count: 1 }] };
  fakeBot.currentWindow = { id: 1, title: 'Chest', slots: new Array(27).fill(null) };
  fakeBot.clickWindow = async () => {};
  session.bot = fakeBot;

  const moveWithWin = await session.handleInventory({ action: 'move', sourceSlot: 36, destSlot: 37 });
  assert.strictEqual(moveWithWin.ok, false);
  assert.strictEqual(moveWithWin.error, 'window_open');

  fakeBot.currentWindow = null;
  await assert.rejects(() => session.handleInventory({ action: 'move', sourceSlot: 36, destSlot: 99 }), /0-45/);
  await assert.rejects(() => session.handleInventory({ action: 'equip', slot: 36, destination: 'invalid_slot' }), /Invalid equip destination/);
  await assert.rejects(() => session.handleInventory({ action: 'unequip', destination: 'bad' }), /Invalid unequip destination/);

  fakeBot.currentWindow = { id: 1, title: 'Chest', slots: new Array(27).fill(null) };
  await assert.rejects(() => session.clickWindow({ slot: 999 }), /Valid slot number/);
  await assert.rejects(() => session.clickWindow({ slot: 0, mouseButton: 5 }), /Invalid mouseButton/);
  await assert.rejects(() => session.clickWindow({ slot: 0, mouseButton: 0, mode: 99 }), /Invalid click mode/);

  await session.resetData();
  assert.strictEqual(session.proxy, null, 'resetData must clear proxy');
  assert.strictEqual(session.connectedAt, null, 'resetData must clear connectedAt');
  assert.strictEqual(session.getStatus().uptimeSeconds, 0, 'uptimeSeconds after resetData must be 0');

  // 12e. ManagerReporter reset() restores stopped reporter & preserves shared DAG objects
  let postCount = 0;
  const rep = new ManagerReporter({
    baseUrl: 'https://mgr.test',
    workerId: 'bot-r4-rep',
    secret: 's'.repeat(32),
    logger: quietLogger,
    fetchImpl: async () => { postCount += 1; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  });
  const shared = { tag: 'ok' };
  rep.enqueueEvent({ type: 'info', a: shared, b: shared });
  assert.deepStrictEqual(rep.eventQueue[0].event.b, { tag: 'ok' }, 'Shared non-circular object must NOT be marked [circular]');
  rep.stop();
  assert.strictEqual(rep.stopping, true);
  rep.reset();
  assert.strictEqual(rep.stopping, false);
  assert.strictEqual(rep.stopController.signal.aborted, false);
  await rep.sendHeartbeat({ state: 'afk' });
  assert.ok(postCount >= 1, 'ManagerReporter.reset() must allow subsequent posts after stop()');
  rep.stop();

  // 12f. WispbyteKeepAlive rejects URL credentials
  const badCredKa = new WispbyteKeepAlive({ cookie: 'sess=1', panelUrl: 'https://user:pass@wispbyte.com/client' }, quietLogger);
  assert.strictEqual(badCredKa.enabled, false);

  // 12g. WispbytePoller includes 'afk' in idle states
  const pollerSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'transports', 'wispbyte-poller.js'), 'utf8');
  assert.ok(pollerSrc.includes("'afk', 'afk_locked'"), 'WispbytePoller adaptive delay must treat afk as idle/steady');

  // 12h. ServerAuth.reset() clears lastActionAt so quick reconnects never drop /login prompts; scheduleReconnect bounds jitter to config scale
  const { ServerAuth } = require('../src/game/server-auth');
  const auth = new ServerAuth({ password: 'SecretPassword', enabled: true, logger: quietLogger });
  const authChats = [];
  const authBot = { entity: { position: { x: 5, y: 119, z: 4 } }, chat: (m) => authChats.push(m) };
  assert.strictEqual(auth.handleMessage(authBot, 'Please /login password'), true);
  assert.strictEqual(authChats.length, 1);
  // Immediately after reconnect, reset() allows responding to fresh /login prompt without hitting 3s old-connection throttle
  auth.reset();
  assert.strictEqual(auth.lastActionAt, 0);
  assert.strictEqual(auth.isAuthenticated(), false);
  assert.strictEqual(auth.handleMessage(authBot, 'Please /login password'), true);
  assert.strictEqual(authChats.length, 2, 'Reset ServerAuth must immediately reply to login prompt on reconnected session');

  const fastSchedLogs = [];
  const fastSession = new MinecraftSession({
    workerId: 'bot-r4-fast-reconn',
    autoReconnect: true,
    reconnectBaseMs: 150,
    reconnectMaxMs: 1000,
    reconnectMaxAttempts: 5,
    mc: { hosts: ['127.0.0.1'], port: 25565, version: '1.20.1', username: 'FastReconn', password: 'pw' }
  }, {
    info: (ev, meta) => { if (ev === 'minecraft_reconnect_scheduled') fastSchedLogs.push(meta.delayMs); },
    warn: () => {}, error: () => {}, debug: () => {}
  });
  fastSession.manualStop = false;
  for (let i = 0; i < 10; i += 1) {
    fastSession.reconnectAttempts = 0;
    fastSession.scheduleReconnect();
    if (fastSession.reconnectTimer) { clearTimeout(fastSession.reconnectTimer); fastSession.reconnectTimer = null; }
  }
  assert.strictEqual(fastSchedLogs.length, 10);
  assert.ok(fastSchedLogs.every((d) => d >= 150 && d <= 350), `Fast reconnectBaseMs=150 must stay bounded (got ${fastSchedLogs.join(',')})`);
  fastSession.stop('test_cleanup', { emitEvent: false });

  console.log('✅ 12. [W-12] Round-4 independent audit worker fixes verified 100%.');
}

async function testW13HostFailoverAndWhitelist() {
  console.log('13. [W-13] Testing Host Whitelist & 3-failure failover rotation...');
  const { loadConfig } = require('../src/config/env');
  const baseEnv = {
    MANAGER_URL: 'https://manager.kbot.test',
    WORKER_ID: 'bot1',
    WORKER_SECRET: '12345678901234567890123456789012'
  };

  // 1. Whitelist enforcement
  assert.throws(() => {
    loadConfig({ ...baseEnv, MC_SERVER_HOSTS: 'kingmc.vn,malicious.com' });
  }, /MC_SERVER_HOSTS can only contain kingmc\.vn and sgp\.kingmc\.vn/);

  const cfg = loadConfig({ ...baseEnv, MC_SERVER_HOSTS: 'kingmc.vn,sgp.kingmc.vn' });
  assert.deepStrictEqual(cfg.mc.hosts, ['kingmc.vn', 'sgp.kingmc.vn']);

  // 2. 3-failure failover rotation
  const session = new MinecraftSession({
    workerId: 'bot1',
    transport: 'render-http',
    mc: {
      hosts: ['kingmc.vn', 'sgp.kingmc.vn'],
      port: 25565
    }
  }, { info: () => {}, warn: () => {}, error: () => {} });

  assert.strictEqual(session._getCurrentHost(), 'kingmc.vn');
  assert.strictEqual(session.consecutiveHostFailures, 0);

  // Failure 1
  session._recordHostFailure('kingmc.vn');
  assert.strictEqual(session.consecutiveHostFailures, 1);
  assert.strictEqual(session._getCurrentHost(), 'kingmc.vn');

  // Failure 2
  session._recordHostFailure('kingmc.vn');
  assert.strictEqual(session.consecutiveHostFailures, 2);
  assert.strictEqual(session._getCurrentHost(), 'kingmc.vn');

  // Failure 3 -> should switch to sgp.kingmc.vn and reset consecutiveHostFailures to 0
  session._recordHostFailure('kingmc.vn');
  assert.strictEqual(session.consecutiveHostFailures, 0);
  assert.strictEqual(session._getCurrentHost(), 'sgp.kingmc.vn');

  // Failure on sgp.kingmc.vn: 1 and 2 stay on sgp.kingmc.vn
  session._recordHostFailure('sgp.kingmc.vn');
  assert.strictEqual(session.consecutiveHostFailures, 1);
  assert.strictEqual(session._getCurrentHost(), 'sgp.kingmc.vn');

  // Successful spawn resets consecutive failures
  const fakeSpawnBot = new EventEmitter();
  fakeSpawnBot.player = {};
  fakeSpawnBot._client = new EventEmitter();
  session.bot = fakeSpawnBot;
  session.manualStop = false;
  session.onSpawn(fakeSpawnBot, session.generation, 'sgp.kingmc.vn');
  assert.strictEqual(session.consecutiveHostFailures, 0);
  assert.strictEqual(session._getCurrentHost(), 'sgp.kingmc.vn');

  // 3 more failures switch back to kingmc.vn
  session._recordHostFailure('sgp.kingmc.vn');
  session._recordHostFailure('sgp.kingmc.vn');
  session._recordHostFailure('sgp.kingmc.vn');
  assert.strictEqual(session._getCurrentHost(), 'kingmc.vn');

  await session.stop('test_cleanup', { emitEvent: false });
  console.log('✅ 13. [W-13] Host Whitelist & 3-failure failover rotation verified 100%.');
}

async function main() {
  console.log('--- [WORKER DEEP AUDIT FIXES REGRESSION TESTS] ---');
  await testW01NonLifecycleTimeoutPreservesSession();
  await testW02UpdateSlotBumpsInventoryRevision();
  await testW03PollerAuthToleranceAndRecovery();
  await testW04SequenceGuardAndSignalIsolation();
  await testW05EmptyBotPasswordAllowed();
  await testW06TpsPreservedAndOffhandCounting();
  await testSec04AndSec06Hardening();
  await testW08LiveSettingsAndAutomation();
  await testW09AfkAlertsAndAntiCheatJitter();
  await testW10UltraDeepAuditFixes();
  await testW11Round3AdversarialAuditFixes();
  await testW12Round4IndependentAuditFixes();
  await testW13HostFailoverAndWhitelist();
  console.log('\n🎉 ALL WORKER DEEP AUDIT FIXES REGRESSION TESTS PASSED 100%!');
}

main().catch((err) => {
  console.error('❌ WORKER DEEP AUDIT TEST FAILED:', err);
  process.exit(1);
});
