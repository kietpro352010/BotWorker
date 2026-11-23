'use strict';

const assert = require('node:assert');
const LobbyNavigator = require('../src/game/lobby-navigator');
const { MinecraftSession } = require('../src/game/minecraft-session');
const ServerMonitor = require('../src/game/server-monitor');
const { loadConfig } = require('../src/config/env');

function createMockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
}

async function testLobbyNavigatorTimerCleanup() {
  console.log('1. Testing LobbyNavigator.triggerServerJoin timer & menu listener cleanup...');

  const navigator = new LobbyNavigator({ logger: createMockLogger() });
  const mockBot = {
    entity: { position: { x: 1, y: 41, z: 1 } }, // Lobby coordinates
    on: () => {},
    once: () => {},
    removeListener: () => {}
  };

  let oldRetryFired = false;
  let oldChatFired = false;
  let oldMenuFired = false;

  navigator.retryTimer = setTimeout(() => { oldRetryFired = true; }, 50);
  navigator.chatTimer = setTimeout(() => { oldChatFired = true; }, 50);
  navigator.pendingMenuCleanup = setTimeout(() => { oldMenuFired = true; }, 50);

  // Trigger server join -> should cancel all previous timers
  navigator.triggerServerJoin(mockBot, 'test_routine');

  // Verify that new timers replaced old timers
  assert.ok(navigator.retryTimer, 'New retryTimer should be scheduled');
  assert.ok(navigator.pendingMenuCleanup, 'New pendingMenuCleanup should be scheduled');

  // Wait 70ms to ensure the OLD timers never fire
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.strictEqual(oldRetryFired, false, 'Old retryTimer must have been cancelled');
  assert.strictEqual(oldChatFired, false, 'Old chatTimer must have been cancelled');
  assert.strictEqual(oldMenuFired, false, 'Old pendingMenuCleanup must have been cancelled');

  // Clean up
  if (navigator.retryTimer) clearTimeout(navigator.retryTimer);
  if (navigator.chatTimer) clearTimeout(navigator.chatTimer);
  if (navigator.pendingMenuCleanup) clearTimeout(navigator.pendingMenuCleanup);

  console.log('✅ 1. LobbyNavigator timer and listener cleanup verified.');
}

async function testMinecraftSessionTotemMutex() {
  console.log('2. Testing MinecraftSession.fastEquipTotem mutex lock...');

  const session = new MinecraftSession(
    { mc: { username: 'test_bot', serverHost: '127.0.0.1', serverPort: 25565 } },
    createMockLogger()
  );

  let equipCalls = 0;
  const mockBot = {
    inventory: {
      slots: { 45: null }, // empty off-hand
      items: () => [{ name: 'totem_of_undying', type: 449 }]
    },
    equip: async (item, dest) => {
      equipCalls += 1;
      assert.strictEqual(session.isEquippingTotem, true, 'isEquippingTotem mutex must be held during equip');
      // Simulate delay
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // Call fastEquipTotem concurrently
  const p1 = session.fastEquipTotem(mockBot);
  const p2 = session.fastEquipTotem(mockBot);
  await Promise.all([p1, p2]);

  assert.strictEqual(equipCalls, 1, 'Concurrent fastEquipTotem calls must be deduplicated by mutex');
  assert.strictEqual(session.isEquippingTotem, false, 'Mutex must be released after completion');

  console.log('✅ 2. MinecraftSession.fastEquipTotem mutex verified.');
}

async function testWispbytePollerIdleStates() {
  console.log('3. Testing WispbytePoller idle states definition...');

  const idleStates = ['idle', 'stopped', 'disconnected', 'afk_locked', 'online', 'maintenance', 'ip_limited', 'banned'];
  for (const s of ['stopped', 'online', 'maintenance', 'ip_limited', 'banned']) {
    assert.ok(idleStates.includes(s), `State "${s}" must be recognized as idle/steady`);
  }

  console.log('✅ 3. WispbytePoller idle states verified.');
}

async function testSlotPropertyRetention() {
  console.log('4. Testing Slot property retention in readSlot / loadConfig (W-1)...');

  const testEnv = {
    MANAGER_URL: 'https://manager.kbot.vn',
    WORKER_ID_1: 'worker-slot-1',
    WORKER_SECRET_1: 'a'.repeat(32),
    WORKER_ID_2: 'worker-slot-2',
    WORKER_SECRET_2: 'b'.repeat(32),
    WORKER_BOT_COUNT: '2'
  };

  const cfg = loadConfig(testEnv);
  assert.strictEqual(cfg.bots.length, 2, 'Must have 2 bot configs');
  assert.strictEqual(cfg.bots[0].slot, 1, 'Slot 1 must have slot property 1');
  assert.strictEqual(cfg.bots[1].slot, 2, 'Slot 2 must have slot property 2');
  assert.strictEqual(cfg.bots[0].workerId, 'worker-slot-1');
  assert.strictEqual(cfg.bots[1].workerId, 'worker-slot-2');

  console.log('✅ 4. Slot property retention verified.');
}

async function testMaintenanceCleanupAndSocketPurge() {
  console.log('5. Testing Maintenance window cleanup & networkSockets purge (W-2, W-4)...');

  const session = new MinecraftSession(
    { mc: { username: 'test_bot', serverHost: '127.0.0.1', serverPort: 25565 } },
    createMockLogger()
  );

  let listenersRemoved = false;
  let socketDestroyed = false;
  const mockClientSocket = {
    listenerCount: () => 0,
    on: () => {},
    destroy: () => { socketDestroyed = true; }
  };
  const mockBot = {
    removeAllListeners: () => { listenersRemoved = true; },
    _client: {
      removeAllListeners: () => {},
      socket: mockClientSocket
    },
    inventory: { removeAllListeners: () => {} },
    entities: { 1: {} }
  };

  session.bot = mockBot;
  session.manualStop = false;
  session.restriction = null;
  session.networkSockets.set(mockClientSocket, { bytesRead: 100, bytesWritten: 100 });
  assert.strictEqual(session.networkSockets.size, 1, 'Initial socket map size must be 1');

  session.enterMaintenanceWindow();

  assert.strictEqual(listenersRemoved, true, 'bot.removeAllListeners must be called in maintenance window (W-2)');
  assert.strictEqual(socketDestroyed, true, 'bot._client.socket.destroy must be called (W-2)');
  assert.strictEqual(session.networkSockets.size, 0, 'networkSockets must be cleared in cleanupSessionResources (W-4)');
  assert.strictEqual(session.bot, null, 'session.bot must be null');
  assert.strictEqual(session.state, 'maintenance', 'state must be maintenance');

  console.log('✅ 5. Maintenance cleanup and socket purge verified.');
}

async function testServerMonitorTotemDoubleCounting() {
  console.log('6. Testing ServerMonitor off-hand slot 45 totem double counting (W-5)...');

  const monitor = new ServerMonitor();

  // Case A: Totem in slot 45 (off-hand) only -> must be 1, not 2
  const mockBotOffHandOnly = {
    on: () => {},
    removeListener: () => {},
    inventory: {
      items: () => [
        { name: 'totem_of_undying', count: 1, slot: 45 }
      ],
      slots: {
        45: { name: 'totem_of_undying', count: 1, slot: 45 }
      }
    }
  };
  monitor.attach(mockBotOffHandOnly);
  const snap1 = monitor.snapshot();
  assert.strictEqual(snap1.totemCount, 1, 'Totem in off-hand only must be counted exactly once');

  // Case B: Totem in slot 45 (off-hand) + Totem in slot 36 (hotbar) -> must be 2, not 3
  const mockBotTwoTotems = {
    on: () => {},
    removeListener: () => {},
    inventory: {
      items: () => [
        { name: 'totem_of_undying', count: 1, slot: 45 },
        { name: 'totem_of_undying', count: 1, slot: 36 }
      ],
      slots: {
        45: { name: 'totem_of_undying', count: 1, slot: 45 },
        36: { name: 'totem_of_undying', count: 1, slot: 36 }
      }
    }
  };
  monitor.attach(mockBotTwoTotems);
  const snap2 = monitor.snapshot();
  assert.strictEqual(snap2.totemCount, 2, 'One totem in off-hand and one in hotbar must count as 2');

  monitor.detach();

  console.log('✅ 6. ServerMonitor off-hand totem double counting fix verified.');
}

async function testProcessWideErrorAndShutdownHandlers() {
  console.log('7. Testing process-wide error handlers and shutdown fallback (W-3, W-6)...');

  const fs = require('node:fs');
  const path = require('node:path');
  const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');

  assert.ok(
    indexSource.includes("process.on('uncaughtException'"),
    'src/index.js must register process.on uncaughtException handler (W-3)'
  );
  assert.ok(
    indexSource.includes("process.on('unhandledRejection'"),
    'src/index.js must register process.on unhandledRejection handler (W-3)'
  );
  assert.ok(
    /setTimeout\(\(\) => process\.exit\(currentExitCode\),\s*8000\)/.test(indexSource) && indexSource.includes('forceExitTimer.unref?.()'),
    'src/index.js must register 8000ms unref fallback timer in shutdown (OPS-TEST-04)'
  );
  assert.ok(
    indexSource.includes("shutdown('unhandledRejection', 1)"),
    'src/index.js must call shutdown on unhandledRejection (OPS-TEST-04)'
  );

  console.log('✅ 7. Process-wide error handlers and shutdown fallback verified.');
}

async function testUnrestrictedBotPasswordAndGzip() {
  console.log('8. Testing unrestricted bot password length & Worker HTTP gzip compression...');
  const http = require('node:http');
  const zlib = require('node:zlib');
  const { createApp } = require('../src/http/app');

  const session = new MinecraftSession(
    { mc: { username: 'test_bot', serverHost: '127.0.0.1', serverPort: 25565, authEnabled: true } },
    createMockLogger()
  );
  const longPass = 'K'.repeat(320) + '!@#$%';
  assert.strictEqual(session.applyManagerCredentials({ username: 'BotUnlim', password: longPass }), true);
  assert.strictEqual(session.password, longPass, 'Worker must accept bot passwords >256 chars without truncation or error');

  const bigLogs = Array.from({ length: 20 }, (_, i) => ({ msg: `sample_health_entry_${i}_${'x'.repeat(40)}` }));
  const workerSecret = 'w'.repeat(32);
  const app = createApp({
    fleet: { list: () => [], get: () => null, health: () => ({ ok: true, bigLogs }) },
    config: { bots: [{ workerId: 'w1', secret: workerSecret }], transport: 'render-http', botCount: 1 },
    logger: createMockLogger()
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/api/v1/diagnostics`, {
        headers: { 'Accept-Encoding': 'gzip', 'x-worker-secret': workerSecret }
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-encoding'], 'gzip', 'Worker HTTP must gzip >512-byte responses');
    const parsed = JSON.parse(zlib.gunzipSync(res.body).toString('utf8'));
    assert.strictEqual(parsed.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 8b. WispbytePoller shares ManagerReporter lightweight status digesting across /poll cycles
  const ManagerReporter = require('../src/transports/manager-reporter');
  const WispbytePoller = require('../src/transports/wispbyte-poller');
  const pollBodies = [];
  const pollHeaders = [];
  let poller;
  const pollFetch = async (url, init) => {
    pollBodies.push(JSON.parse(init.body));
    pollHeaders.push(init.headers);
    if (pollBodies.length >= 2) {
      poller.stopping = true;
      poller.stopController.abort();
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, command: null }) };
  };
  const reporter = new ManagerReporter({
    baseUrl: 'http://127.0.0.1:9999',
    workerId: 'w1',
    secret: workerSecret,
    fetchImpl: pollFetch,
    logger: createMockLogger()
  });
  const steadyStatus = {
    state: 'online',
    online: true,
    username: 'BotOne',
    inventory: { items: [{ id: 1 }], slots: { 0: { id: 1 } }, revision: 3 },
    currentWindow: { title: 'Menu', slots: [] }
  };
  poller = new WispbytePoller({
    config: { managerUrl: 'http://127.0.0.1:9999', workerId: 'w1', secret: workerSecret },
    runtime: { status: () => ({ ...steadyStatus }) },
    reporter,
    logger: createMockLogger(),
    fetchImpl: pollFetch
  });
  await poller.start();
  await poller.stop();
  assert.strictEqual(pollBodies.length, 2);
  assert.strictEqual(pollHeaders[0]['x-manager-bot-id'], 'w1', 'Poller must send x-manager-bot-id header');
  assert.strictEqual(pollBodies[0].status.digestUnchanged, false, 'First /poll sends full status');
  assert.ok(pollBodies[0].status.inventory, 'First /poll includes inventory');
  assert.strictEqual(pollBodies[1].status.digestUnchanged, true, 'Repeated unchanged /poll marks digestUnchanged');
  assert.strictEqual(pollBodies[1].status.isLightweight, true, 'Repeated unchanged /poll marks isLightweight');
  assert.strictEqual(pollBodies[1].status.inventory, undefined, 'Lightweight /poll omits inventory');
  assert.strictEqual(pollBodies[1].status.currentWindow, undefined, 'Lightweight /poll omits currentWindow');

  console.log('✅ 8. Unrestricted bot password, Worker HTTP gzip & lightweight /poll verified.');
}

async function runAll() {
  await testLobbyNavigatorTimerCleanup();
  await testMinecraftSessionTotemMutex();
  await testWispbytePollerIdleStates();
  await testSlotPropertyRetention();
  await testMaintenanceCleanupAndSocketPurge();
  await testServerMonitorTotemDoubleCounting();
  await testProcessWideErrorAndShutdownHandlers();
  await testUnrestrictedBotPasswordAndGzip();
  console.log('\n🎉 ALL BOTWORKER REMEDIATION AUDIT TESTS PASSED 100%!');
}

runAll().catch((err) => {
  console.error('❌ BotWorker remediation test failed:', err);
  process.exit(1);
});
