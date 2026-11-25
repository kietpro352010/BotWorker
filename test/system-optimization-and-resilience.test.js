'use strict';

const assert = require('node:assert');
const EventEmitter = require('node:events');

const ManagerReporter = require('../src/transports/manager-reporter');
const WispbytePoller = require('../src/transports/wispbyte-poller');
const WorkerFleet = require('../src/services/worker-fleet');
const logger = require('../src/utils/logger');
const { ServerAuth, redactAuditValue } = require('../src/game/server-auth');
const { detectHostRuntime } = require('../src/config/host-runtime');
const {
  pruneFarChunks,
  enforceZeroFarmEntities,
  stopEntityPruner,
  attachEarlyPacketDropFilter,
  setAfkWorldChunkLock,
  setPhysicsEnabled,
  AFK_GROUND_SENTINEL
} = require('../src/game/packet-optimization');
const { MinecraftSession } = require('../src/game/minecraft-session');

function createSilentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

async function testManagerReporterDigestAndRollback() {
  console.log('1. Testing ManagerReporter digest lifecycle, 5-block movement, 300s ceiling & error rollback...');
  const sentBodies = [];
  let shouldFail = false;

  const fetchImpl = async (_url, init) => {
    if (shouldFail) throw new Error('network_down');
    sentBodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const reporter = new ManagerReporter({
    baseUrl: 'https://mgr.example.com',
    workerId: 'bot-01',
    secret: 's'.repeat(32),
    fetchImpl,
    logger: createSilentLogger()
  });

  const baseStatus = {
    state: 'online',
    online: true,
    username: 'Hero',
    health: 20,
    food: 20,
    totemCount: 2,
    pingMs: 25,
    locationState: 'Game',
    position: { x: 100, y: 64, z: 100 },
    inventory: { items: [{ id: 1, name: 'totem_of_undying', count: 2 }], slots: { 45: { id: 1 } }, revision: 1 },
    currentWindow: null
  };

  // 1a. Initial send -> full payload
  await reporter.sendHeartbeat({ ...baseStatus });
  assert.strictEqual(sentBodies.length, 1);
  assert.strictEqual(sentBodies[0].status.digestUnchanged, false);
  assert.ok(sentBodies[0].status.inventory, 'Initial heartbeat includes inventory');
  assert.deepStrictEqual(sentBodies[0].status.position, { x: 100, y: 64, z: 100 });

  // 1b. Unchanged state + <5 blocks moved -> lightweight payload omitting inventory/currentWindow/position
  await reporter.sendHeartbeat({ ...baseStatus, position: { x: 102, y: 64, z: 101 } });
  assert.strictEqual(sentBodies.length, 2);
  assert.strictEqual(sentBodies[1].status.digestUnchanged, true);
  assert.strictEqual(sentBodies[1].status.isLightweight, true);
  assert.strictEqual(sentBodies[1].status.positionUnchanged, true);
  assert.strictEqual(sentBodies[1].status.inventory, undefined);
  assert.strictEqual(sentBodies[1].status.currentWindow, undefined);
  assert.strictEqual(sentBodies[1].status.position, undefined);

  // 1c. Move >= 5 blocks while digest unchanged -> still lightweight for inventory, includes new position
  await reporter.sendHeartbeat({ ...baseStatus, position: { x: 108, y: 64, z: 100 } });
  assert.strictEqual(sentBodies.length, 3);
  assert.strictEqual(sentBodies[2].status.digestUnchanged, true);
  assert.strictEqual(sentBodies[2].status.inventory, undefined);
  assert.deepStrictEqual(sentBodies[2].status.position, { x: 108, y: 64, z: 100 });

  // 1d. Inventory revision / currentWindow change must trigger full sync immediately
  await reporter.sendHeartbeat({
    ...baseStatus,
    position: { x: 108, y: 64, z: 100 },
    inventory: { items: [{ id: 1, count: 1 }], slots: {}, revision: 2 },
    currentWindow: { title: 'KingMC Menu', slots: [{ slot: 0, name: 'compass' }], revision: 4 }
  });
  assert.strictEqual(sentBodies.length, 4);
  assert.strictEqual(sentBodies[3].status.digestUnchanged, false, 'Inventory/Window update must break lightweight mode');
  assert.strictEqual(sentBodies[3].status.inventory.revision, 2);
  assert.strictEqual(sentBodies[3].status.currentWindow.title, 'KingMC Menu');

  // 1e. Aged >300s forces periodic full sync even when digest unchanged
  const latestStatus = {
    ...baseStatus,
    position: { x: 108, y: 64, z: 100 },
    inventory: { items: [{ id: 1, count: 1 }], slots: {}, revision: 2 },
    currentWindow: { title: 'KingMC Menu', slots: [{ slot: 0, name: 'compass' }], revision: 4 }
  };
  reporter.lastFullReportAt = Date.now() - 301000;
  await reporter.sendHeartbeat(latestStatus);
  assert.strictEqual(sentBodies.length, 5);
  assert.strictEqual(sentBodies[4].status.digestUnchanged, false, '>300s elapsed must trigger full refresh');
  assert.ok(sentBodies[4].status.inventory);

  // 1f. Failed send on changed state must NOT advance digest -> subsequent retry sends full payload
  const newState = { ...latestStatus, totemCount: 1 };
  shouldFail = true;
  await assert.rejects(() => reporter.sendHeartbeat(newState), /network_down/);
  shouldFail = false;
  await reporter.sendHeartbeat(newState);
  assert.strictEqual(sentBodies.length, 6);
  assert.strictEqual(sentBodies[5].status.digestUnchanged, false, 'Retry after failed POST must still send full payload');
  assert.strictEqual(sentBodies[5].status.totemCount, 1);

  console.log('✅ 1. ManagerReporter digest lifecycle, 5-block movement, 300s ceiling & rollback verified.');
}

async function testWispbytePollerCommandAndStubFallback() {
  console.log('2. Testing WispbytePoller poll -> command dispatch -> /result & stub reporter fallback...');
  const calls = [];
  let poller;
  const fetchWithCommand = async (url, init) => {
    const pathPart = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ pathPart, headers: init.headers, body });
    if (pathPart.endsWith('/poll')) {
      const pollNum = calls.filter((c) => c.pathPart.endsWith('/poll')).length;
      if (pollNum === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            command: {
              commandId: 'cmd_11111111-1111-1111-1111-111111111111',
              action: 'chat',
              payload: { message: '/ping' }
            }
          })
        };
      }
      poller.stopping = true;
      poller.stopController.abort();
      return { ok: true, status: 200, json: async () => ({ ok: true, command: null }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const executed = [];
  const reporter = new ManagerReporter({
    baseUrl: 'https://mgr.example.com',
    workerId: 'w-poll-1',
    secret: 'p'.repeat(32),
    fetchImpl: fetchWithCommand,
    logger: createSilentLogger()
  });

  poller = new WispbytePoller({
    config: { managerUrl: 'https://mgr.example.com', workerId: 'w-poll-1', secret: 'p'.repeat(32) },
    runtime: {
      status: () => ({ state: 'online', online: true, username: 'PollerBot', inventory: { items: [], revision: 1 } }),
      execute: async (action, payload) => {
        executed.push({ action, payload });
        return { ok: true, sent: true };
      }
    },
    reporter,
    logger: createSilentLogger(),
    fetchImpl: fetchWithCommand
  });

  await poller.start();
  await poller.stop();

  const pollCalls = calls.filter((c) => c.pathPart.endsWith('/poll'));
  const resultCalls = calls.filter((c) => c.pathPart.endsWith('/result'));
  assert.strictEqual(pollCalls.length, 2);
  assert.strictEqual(resultCalls.length, 1);
  assert.strictEqual(pollCalls[0].headers['x-manager-bot-id'], 'w-poll-1');
  assert.strictEqual(pollCalls[0].body.status.digestUnchanged, false);
  assert.strictEqual(pollCalls[1].body.status.isLightweight, true);
  assert.strictEqual(executed.length, 1);
  assert.strictEqual(executed[0].action, 'chat');
  assert.strictEqual(resultCalls[0].body.result.ok, true);

  // Stub reporter lacking prepareStatusPayload/recordStatusSent must work cleanly
  const stubCalls = [];
  let stubPoller;
  stubPoller = new WispbytePoller({
    config: { managerUrl: 'https://mgr.example.com', workerId: 'w-stub', secret: 'p'.repeat(32) },
    runtime: { status: () => ({ state: 'online', customField: 42 }) },
    reporter: { managerLatencyMs: 12 },
    logger: createSilentLogger(),
    fetchImpl: async (url, init) => {
      stubCalls.push(JSON.parse(init.body));
      stubPoller.stopping = true;
      stubPoller.stopController.abort();
      return { ok: true, status: 200, json: async () => ({ ok: true, command: null }) };
    }
  });
  await stubPoller.start();
  await stubPoller.stop();
  assert.strictEqual(stubCalls[0].status.customField, 42);
  assert.strictEqual(stubCalls[0].status.managerLatencyMs, 12);

  console.log('✅ 2. WispbytePoller command cycle & stub reporter fallback verified.');
}

async function testWorkerFleetHeartbeatDeduplication() {
  console.log('3. Testing WorkerFleet heartbeat skip for healthy poller & resume on degradation...');
  const capturedIntervals = [];
  const origSetInterval = global.setInterval;
  const postedPaths = [];

  const mockFetch = async (url) => {
    const pathname = new URL(url).pathname;
    postedPaths.push(pathname);
    if (pathname.endsWith('/bootstrap')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          settings: { ecoMode: true },
          credentials: { username: 'FleetBot', password: 'secret' }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, command: null }) };
  };

  const config = {
    transport: 'wispbyte-poll',
    autoStart: false,
    rssWarnMb: 440,
    wispbyte: { cookie: '', panelUrl: 'https://wispbyte.com/client', intervalMs: 86400000 },
    bots: [{
      slot: 1,
      workerId: 'fleet-w1',
      secret: 'f'.repeat(32),
      managerUrl: 'https://mgr.example.com',
      transport: 'wispbyte-poll',
      mc: { hosts: ['kingmc.vn'], port: 25565, version: '1.20.1', viewDistance: 'tiny', authType: 'offline' },
      afk: { mode: 'still', minMs: 180000, maxMs: 360000 }
    }]
  };

  let fleet;
  global.setInterval = (fn, ms, ...args) => {
    const handle = origSetInterval(fn, ms, ...args);
    capturedIntervals.push({ fn, ms, handle });
    return handle;
  };
  try {
    fleet = new WorkerFleet(config, createSilentLogger(), { fetchImpl: mockFetch });
    const inst = fleet.get('fleet-w1');
    inst.poller.start = () => Promise.resolve();
    inst.poller.stop = async () => { inst.poller.stopping = true; };

    await fleet.start();
    const hbEntry = capturedIntervals.find((item) => item.ms === 45000);
    assert.ok(hbEntry, 'WorkerFleet must register 45s heartbeatTimer');

    const hbCountBefore = postedPaths.filter((p) => p.endsWith('/heartbeat')).length;
    inst.poller.stopping = false;
    inst.poller.failures = 0;
    hbEntry.fn();
    await new Promise((r) => setTimeout(r, 20));
    const hbCountHealthy = postedPaths.filter((p) => p.endsWith('/heartbeat')).length;
    assert.strictEqual(hbCountHealthy, hbCountBefore, 'Healthy wispbyte poller skips redundant /heartbeat POST');

    // Simulate poller failures -> heartbeat fallback resumes immediately
    inst.poller.failures = 2;
    hbEntry.fn();
    await new Promise((r) => setTimeout(r, 20));
    const hbCountDegraded = postedPaths.filter((p) => p.endsWith('/heartbeat')).length;
    assert.strictEqual(hbCountDegraded, hbCountBefore + 1, 'Degraded wispbyte poller resumes /heartbeat POST');
  } finally {
    global.setInterval = origSetInterval;
    if (fleet) await fleet.stop();
  }

  console.log('✅ 3. WorkerFleet heartbeat deduplication & degraded fallback verified.');
}

async function testServerAuthAndHardenedLogger() {
  console.log('4. Testing ServerAuth unrestricted passwords, redaction & hardened Worker logger...');
  const chats = [];
  const fakeBot = {
    entity: { position: { x: 5, y: 119, z: 4 } },
    chat: (msg) => chats.push(msg)
  };

  for (const pass of ['x', 'p@$$!#%9', 'Q'.repeat(350)]) {
    const auth = new ServerAuth({ password: pass, enabled: true, logger: createSilentLogger() });
    assert.strictEqual(auth.sendDirectAuth(fakeBot, 'dn'), true);
    assert.strictEqual(chats[chats.length - 1], `/dn ${pass}`);
    auth.lastActionAt = 0;
    assert.strictEqual(auth.handleMessage(fakeBot, 'Vui lòng dùng lệnh /login <mat khau> để đăng nhập'), true);
    assert.strictEqual(chats[chats.length - 1], `/login ${pass}`);
  }
  assert.throws(() => new ServerAuth({ password: 'bad\tpass', enabled: true, logger: createSilentLogger() }));

  // Empty password must safely skip /login without throwing or chatting empty string
  const chatsBeforeEmpty = chats.length;
  const emptyAuth = new ServerAuth({ password: '', enabled: true, logger: createSilentLogger() });
  assert.strictEqual(emptyAuth.sendDirectAuth(fakeBot, 'login'), false);
  assert.strictEqual(emptyAuth.handleMessage(fakeBot, 'Please /login now'), false);
  assert.strictEqual(chats.length, chatsBeforeEmpty);

  assert.strictEqual(redactAuditValue('/login MyVerySecretPass'), '/login *** REDACTED ***');
  assert.strictEqual(redactAuditValue('/register Abc123 Abc123'), '/register *** REDACTED ***');

  const lines = [];
  const origLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    const circular = { proxyUrl: 'socks5://user:topsecret@1.2.3.4:1080', token: 'abc' };
    circular.loop = circular;
    logger.info('spoof_check', {
      level: 'error',
      message: 'spoofed',
      time: '1970-01-01T00:00:00.000Z',
      nested: circular,
      err: new Error('worker_boom')
    });
  } finally {
    console.log = origLog;
  }
  assert.strictEqual(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.strictEqual(parsed.level, 'info', 'Caller fields must not spoof logger level');
  assert.strictEqual(parsed.message, 'spoof_check', 'Caller fields must not spoof logger message');
  assert.notStrictEqual(parsed.time, '1970-01-01T00:00:00.000Z', 'Caller fields must not spoof timestamp');
  assert.strictEqual(parsed.nested.proxyUrl, '[REDACTED]');
  assert.strictEqual(parsed.nested.token, '[REDACTED]');
  assert.strictEqual(parsed.nested.loop, '[CIRCULAR]');
  assert.strictEqual(parsed.err.message, 'worker_boom');

  console.log('✅ 4. ServerAuth unrestricted passwords, redaction & logger hardening verified.');
}

async function testHostRuntimeParityAndPacketOptimizationEdgeCases() {
  console.log('5. Testing host-runtime detection parity & packet-optimization edge safety...');
  const renderRt = detectHostRuntime({ RENDER_SERVICE_NAME: 'kingmc-worker-1', PORT: '12345' });
  assert.strictEqual(renderRt.platform, 'render');
  assert.strictEqual(renderRt.transport, 'render-http');
  assert.strictEqual(renderRt.port, 12345);

  const wispRt = detectHostRuntime({ P_SERVER_UUID: 'abc', SERVER_PORT: '25599' });
  assert.strictEqual(wispRt.platform, 'wispbyte');
  assert.strictEqual(wispRt.transport, 'wispbyte-poll');
  assert.strictEqual(wispRt.port, 25599);

  const genericRt = detectHostRuntime({});
  assert.strictEqual(genericRt.platform, 'generic-node');
  assert.strictEqual(genericRt.transport, 'wispbyte-poll');
  assert.strictEqual(genericRt.port, 10000);

  // Null/empty safety on pruneFarChunks
  assert.strictEqual(pruneFarChunks(null), 0);
  assert.strictEqual(pruneFarChunks({ entity: { position: { x: 0, z: 0 } }, world: null }), 0);

  const unloaded = [];
  const count = pruneFarChunks({
    entity: { position: { x: 8, y: 64, z: 8 } },
    world: {
      getColumns: () => [{ chunkX: 0, chunkZ: 0 }, { chunkX: 2, chunkZ: 2 }, { chunkX: 5, chunkZ: 0 }, { chunkX: NaN, chunkZ: 1 }],
      unloadColumn: (x, z) => unloaded.push(`${x},${z}`)
    }
  }, 2);
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(unloaded, ['5,0']);

  // enforceZeroFarmEntities cleans other entities & clears interval on end
  const fakeBot = new EventEmitter();
  fakeBot.entity = { id: 1 };
  fakeBot.entities = { 1: fakeBot.entity, 2: { id: 2, metadata: ['a'] } };
  enforceZeroFarmEntities(fakeBot);
  assert.ok(fakeBot._kingmcEntityPruneTimer);
  fakeBot.emit('entitySpawn', { id: 3 });
  assert.strictEqual(fakeBot.entities[3], undefined, 'Newly spawned non-self entity immediately deleted');
  fakeBot.emit('end');
  assert.strictEqual(fakeBot._kingmcEntityPruneTimer, null, 'Prune timer cleared on bot end');
  assert.strictEqual(stopEntityPruner(fakeBot), false);

  console.log('✅ 5. host-runtime detection parity & packet-optimization edge safety verified.');
}

async function testMinecraftSessionWindowSnapshotAndClick() {
  console.log('6. Testing MinecraftSession window snapshot, slot extraction & window lifecycle...');
  const session = new MinecraftSession({
    workerId: 'bot-01',
    transport: 'wispbyte-poll',
    mc: { host: 'mc.example.com', username: 'Tester' }
  }, { logger: createSilentLogger() });

  assert.strictEqual(session.windowRevision, 0);
  assert.strictEqual(session.getWindowSnapshot(null), null);

  const status1 = session.getStatus();
  assert.strictEqual(status1.currentWindow, null);

  // Fake online bot with currentWindow
  const fakeWin = new EventEmitter();
  fakeWin.id = 12;
  fakeWin.type = 'minecraft:chest';
  fakeWin.title = { text: 'Chest of Wonders' };
  fakeWin.slots = [
    { name: 'diamond', count: 64, displayName: 'Diamond' },
    null,
    { name: 'iron_ingot', count: 32 }
  ];

  const fakeBot = new EventEmitter();
  fakeBot.player = {};
  fakeBot._client = { socket: new EventEmitter() };
  fakeBot.currentWindow = fakeWin;
  fakeBot.clickWindow = async (slot) => {
    fakeWin.slots[slot] = null;
  };
  fakeBot.closeWindow = () => {
    fakeBot.currentWindow = null;
  };

  session.bot = fakeBot;
  session.state = 'online';

  const winSnap = session.getWindowSnapshot(fakeBot);
  assert.strictEqual(winSnap.id, 12);
  assert.strictEqual(winSnap.type, 'minecraft:chest');
  assert.strictEqual(winSnap.title, 'Chest of Wonders');
  assert.strictEqual(winSnap.totalSlots, 3);
  assert.strictEqual(winSnap.slots.length, 3);
  assert.strictEqual(winSnap.slots.filter(Boolean).length, 2);
  assert.strictEqual(winSnap.slots[0].name, 'diamond');
  assert.strictEqual(winSnap.slots[1], null);
  assert.strictEqual(winSnap.slots[2].name, 'iron_ingot');

  const status2 = session.getStatus();
  assert.ok(status2.currentWindow);
  assert.strictEqual(status2.currentWindow.id, 12);

  // Test clickWindow
  const clickRes = await session.clickWindow({ slot: 0 });
  assert.strictEqual(clickRes.ok, true);
  assert.strictEqual(clickRes.clickedSlot, 0);
  assert.ok(session.windowRevision >= 1);
  assert.ok(clickRes.currentWindow);

  // Test closeWindow
  const closeRes = await session.closeWindow();
  assert.strictEqual(closeRes.ok, true);
  assert.strictEqual(closeRes.closed, true);
  assert.strictEqual(session.getStatus().currentWindow, null);

  session.cleanupSessionResources();
  console.log('✅ 6. MinecraftSession window snapshot, slot extraction & window lifecycle verified.');
}

async function testAfkWorldChunkLockAndIdleTimers() {
  console.log('7. Testing AFK zero-chunk lock, idle autoChat zero-timer & Map chat dedup...');
  const cols = new Map([['0,0', { chunkX: 0, chunkZ: 0 }], ['1,0', { chunkX: 1, chunkZ: 0 }]]);
  const afkBot = new EventEmitter();
  afkBot.physicsEnabled = false;
  afkBot.entity = { id: 10, position: { x: 8, y: 64, z: 8 } };
  afkBot.world = {
    getColumns: () => [...cols.values()],
    unloadColumn: (x, z) => cols.delete(`${x},${z}`)
  };
  let origCalled = 0;
  afkBot.blockAt = () => {
    origCalled += 1;
    return { name: 'stone' };
  };
  afkBot._client = new EventEmitter();
  attachEarlyPacketDropFilter(afkBot);

  let receivedChunk = 0;
  let receivedBlockChange = 0;
  afkBot._client.on('map_chunk', () => { receivedChunk += 1; });
  afkBot._client.on('block_change', () => { receivedBlockChange += 1; });

  setAfkWorldChunkLock(afkBot, true);
  assert.strictEqual(cols.size, 0, 'AFK chunk lock must unload 100% of loaded chunk columns');
  assert.strictEqual(afkBot.blockAt({ x: 8, y: 64, z: 8 }), AFK_GROUND_SENTINEL);
  assert.strictEqual(origCalled, 0, 'Wrapped blockAt must short-circuit to zero-alloc sentinel when locked');

  afkBot._client.emit('map_chunk', { x: 0, z: 0 });
  afkBot._client.emit('block_change', { location: { x: 8, y: 64, z: 8 } });
  assert.strictEqual(receivedChunk, 0, 'map_chunk must be dropped while AFK chunk lock is active');
  assert.strictEqual(receivedBlockChange, 0, 'block_change must be dropped while AFK chunk lock is active');

  // Re-enabling physics or receiving respawn unlocks chunks
  setPhysicsEnabled(afkBot, true);
  assert.strictEqual(afkBot._kingmcAfkWorldLocked, false);
  assert.deepStrictEqual(afkBot.blockAt({ x: 8, y: 64, z: 8 }), { name: 'stone' });
  assert.strictEqual(origCalled, 1);

  afkBot._client.emit('map_chunk', { x: 0, z: 0 });
  assert.strictEqual(receivedChunk, 1, 'In-range chunk packet allowed when unlocked');
  afkBot._client.emit('map_chunk', { x: 10, z: 10 });
  assert.strictEqual(receivedChunk, 1, 'Out-of-radius (>1 chunk) chunk packet dropped');

  afkBot.physicsEnabled = false;
  setAfkWorldChunkLock(afkBot, true);
  assert.strictEqual(afkBot._kingmcAfkWorldLocked, true);
  afkBot._client.emit('respawn', {});
  assert.strictEqual(afkBot._kingmcAfkWorldLocked, false, 'respawn packet must unlock AFK chunk lock');

  // Idle autoChatSchedules -> 0 timers; enabled schedule -> active timer; disable -> cleared
  const session = new MinecraftSession({
    workerId: 'bot-idle',
    transport: 'wispbyte-poll',
    mc: { host: 'kingmc.vn', username: 'IdleTester' }
  }, createSilentLogger());
  session.bot = afkBot;
  session.manualStop = false;
  session.autoChatSchedules = [];
  session.syncAutoChatLoop(afkBot, session.generation);
  assert.strictEqual(session.autoChatTimer, null, 'Empty autoChatSchedules must allocate zero intervals');

  session.applyManagerSettings({
    autoChatSchedules: [{ id: 'c1', enabled: true, mode: 'interval', intervalSeconds: 60, messages: ['hello'] }]
  });
  assert.ok(session.autoChatTimer, 'Enabled autoChatSchedule must activate autoChatTimer');

  session.applyManagerSettings({
    autoChatSchedules: [{ id: 'c1', enabled: false, mode: 'interval', intervalSeconds: 60, messages: ['hello'] }]
  });
  assert.strictEqual(session.autoChatTimer, null, 'Disabling autoChatSchedule must stop autoChatTimer');

  // Chat deduplication Map without timers
  const emittedChats = [];
  session.on('event', (e) => { if (e?.type === 'chat') emittedChats.push(e.message); });
  session._recordChatMessage('xin chao', 'chat');
  session._recordChatMessage('xin chao', 'chat');
  assert.strictEqual(emittedChats.length, 1, 'Duplicate chat within window suppressed without per-message timers');
  assert.ok(session.recentChatSignatures instanceof Map);

  session.cleanupSessionResources();
  afkBot.emit('end');
  console.log('✅ 7. AFK zero-chunk lock, idle autoChat zero-timer & Map chat dedup verified.');
}

async function testWispbyteLowMemoryBootstrapAndDeployHook() {
  console.log('8. Testing Wispbyte OOM-safe .npmrc, .wispbyte/deploy.sh (LF/POSIX sh) & bootstrap-deps self-healing...');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const {
    ensureRuntimeDependencies,
    buildLowMemoryInstallEnv
  } = require('../src/bootstrap-deps');

  const rootDir = path.resolve(__dirname, '..');

  // 8a. Fast-path when all dependencies are already present
  const okRes = ensureRuntimeDependencies({ rootDir, log: createSilentLogger() });
  assert.strictEqual(okRes.ok, true);
  assert.strictEqual(okRes.healed, false);
  assert.deepStrictEqual(okRes.missing, []);

  // 8b. Normalizes --max-old-space-size to 400MB & sets maxsockets=1
  const lowEnv = buildLowMemoryInstallEnv({ NODE_OPTIONS: '--max-old-space-size=112 --no-warnings' });
  assert.strictEqual(lowEnv.NODE_OPTIONS, '--no-warnings --max-old-space-size=400');
  assert.strictEqual(lowEnv.UV_THREADPOOL_SIZE, '1');
  assert.strictEqual(lowEnv.npm_config_maxsockets, '1');
  assert.strictEqual(lowEnv.npm_config_audit, 'false');
  assert.strictEqual(lowEnv.npm_config_fund, 'false');
  assert.strictEqual(lowEnv.KBOT_AUTO_INSTALL_ATTEMPTED, '1');

  // 8c. Simulated killed npm install (missing express / .package-lock.json) triggers 400MB-capped ci heal once
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbot-wisp-heal-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"t"}');
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{"name":"t","lockfileVersion":3}');

    // Guard blocks recursion when KBOT_AUTO_INSTALL_ATTEMPTED=1
    const guarded = ensureRuntimeDependencies({
      rootDir: tmpDir,
      requiredPackages: ['express'],
      env: { KBOT_AUTO_INSTALL_ATTEMPTED: '1' },
      log: createSilentLogger()
    });
    assert.strictEqual(guarded.ok, false);
    assert.deepStrictEqual(guarded.missing, ['express']);

    const spawnCalls = [];
    const healed = ensureRuntimeDependencies({
      rootDir: tmpDir,
      requiredPackages: ['fake-express'],
      env: { NODE_OPTIONS: '--max-old-space-size=112' },
      log: createSilentLogger(),
      spawnSyncImpl: (_cmd, args, opts) => {
        spawnCalls.push({ args, env: opts.env });
        const modDir = path.join(tmpDir, 'node_modules', 'fake-express');
        fs.mkdirSync(modDir, { recursive: true });
        fs.writeFileSync(path.join(modDir, 'package.json'), '{"name":"fake-express","main":"index.js"}');
        fs.writeFileSync(path.join(modDir, 'index.js'), 'module.exports = {};');
        return { status: 0 };
      }
    });
    assert.strictEqual(healed.ok, true);
    assert.strictEqual(healed.healed, true);
    assert.strictEqual(spawnCalls.length, 1);
    assert.ok(spawnCalls[0].args.includes('ci'), 'Must attempt npm ci first when package-lock.json exists');
    assert.strictEqual(spawnCalls[0].env.NODE_OPTIONS, '--max-old-space-size=400');
    assert.strictEqual(spawnCalls[0].env.npm_config_maxsockets, '1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 8d. Verify .npmrc and .wispbyte/deploy.sh invariants (strictly LF, POSIX sh, no [[ bashisms)
  const npmrc = fs.readFileSync(path.join(rootDir, '.npmrc'), 'utf8');
  assert.ok(npmrc.includes('maxsockets=1'), '.npmrc must set maxsockets=1');
  assert.ok(npmrc.includes('audit=false') && npmrc.includes('fund=false'), '.npmrc must disable audit and fund');
  assert.ok(npmrc.includes('omit=dev'), '.npmrc must omit dev dependencies');

  const deployShBytes = fs.readFileSync(path.join(rootDir, '.wispbyte', 'deploy.sh'));
  assert.strictEqual(deployShBytes.includes(0x0d), false, '.wispbyte/deploy.sh must use pure LF line endings for Linux /bin/sh');
  const deploySh = deployShBytes.toString('utf8');
  assert.ok(deploySh.startsWith('#!/bin/sh\n'), '.wispbyte/deploy.sh must start with #!/bin/sh');
  assert.strictEqual(deploySh.includes('[['), false, '.wispbyte/deploy.sh must not use [[ bashisms under sh');
  assert.ok(deploySh.includes('--max-old-space-size=400'), '.wispbyte/deploy.sh must cap V8 heap at 400MB');
  assert.ok(deploySh.includes('npm_config_maxsockets="1"'), '.wispbyte/deploy.sh must serialize sockets');

  console.log('✅ 8. Wispbyte OOM-safe .npmrc, .wispbyte/deploy.sh & self-healing bootstrap verified.');
}

async function main() {
  console.log('--- [WORKER SYSTEM OPTIMIZATION & RESILIENCE TESTS] ---');
  await testManagerReporterDigestAndRollback();
  await testWispbytePollerCommandAndStubFallback();
  await testWorkerFleetHeartbeatDeduplication();
  await testServerAuthAndHardenedLogger();
  await testHostRuntimeParityAndPacketOptimizationEdgeCases();
  await testMinecraftSessionWindowSnapshotAndClick();
  await testAfkWorldChunkLockAndIdleTimers();
  await testWispbyteLowMemoryBootstrapAndDeployHook();
  console.log('\n🎉 ALL WORKER OPTIMIZATION & RESILIENCE TESTS PASSED 100%!');
}

main().catch((err) => {
  console.error('❌ WORKER OPTIMIZATION TEST FAILED:', err);
  process.exit(1);
});
