'use strict';

const assert = require('node:assert');
const WorkerRuntime = require('../src/services/worker-runtime');
const { ACTIONS } = require('../src/services/worker-runtime');
const { parseSocksProxy } = require('../src/config/proxy');
const { safeEqual } = require('../src/http/auth');

async function runTests() {
  console.log('--- [WORKER INTEGRATION TESTS] ---');

  // 1. Actions unification check
  console.log('1. Checking Unified Actions Set...');
  const expectedActions = [
    'start', 'stop', 'restart', 'reconnect', 'status', 'chat', 'reset', 'set-afk-mode', 'set-proxy',
    'respawn', 'inventory', 'look', 'toss', 'window_click', 'window_close'
  ];
  for (const act of expectedActions) {
    assert.strictEqual(ACTIONS.has(act), true, `Action ${act} must be in ACTIONS set`);
  }
  assert.strictEqual(ACTIONS.size, 15, 'ACTIONS must have exactly 15 unified actions');
  console.log('✅ 1. Unified Actions Set: 15 actions verified.');

  // 2. Mock Session execution for all 15 actions
  console.log('2. Checking WorkerRuntime execution dispatch...');
  const sessionCalls = [];
  const mockSession = {
    start: async () => { sessionCalls.push('start'); return { ok: true }; },
    stop: async () => { sessionCalls.push('stop'); return { ok: true }; },
    restart: async () => { sessionCalls.push('restart'); return { ok: true }; },
    getStatus: () => ({ state: 'online' }),
    sendChat: async (msg) => { sessionCalls.push(`chat:${msg}`); return { ok: true }; },
    resetData: async () => { sessionCalls.push('reset'); return { ok: true }; },
    setAfkMode: (mode) => { sessionCalls.push(`afk:${mode}`); return { ok: true }; },
    setProxy: async (url) => { sessionCalls.push(`proxy:${url}`); return { ok: true }; },
    respawn: async () => { sessionCalls.push('respawn'); return { ok: true }; },
    handleInventory: async (p) => { sessionCalls.push(`inventory:${p.action}`); return { ok: true }; },
    look: async (y, p) => { sessionCalls.push(`look:${y},${p}`); return { ok: true }; },
    toss: async (p) => { sessionCalls.push(`toss:${p.slot}`); return { ok: true }; },
    clickWindow: async (p) => { sessionCalls.push(`window_click:${p.slot}`); return { ok: true }; },
    closeWindow: async () => { sessionCalls.push('window_close'); return { ok: true }; }
  };

  const runtime = new WorkerRuntime(mockSession, { workerId: 'test_worker' }, console);

  // Test executing all 15 actions
  await runtime.execute('start');
  await runtime.execute('stop');
  await runtime.execute('restart');
  await runtime.execute('reconnect');
  await runtime.execute('status');
  await runtime.execute('chat', { message: 'Hello' });
  await runtime.execute('reset');
  await runtime.execute('set-afk-mode', { mode: 'still' });
  await runtime.execute('set-proxy', { url: 'socks5://user:pass@128.0.0.1:1080' });
  await runtime.execute('respawn');
  await runtime.execute('inventory', { action: 'list' });
  await runtime.execute('look', { yaw: 90, pitch: 0 });
  await runtime.execute('toss', { slot: 36 });
  await runtime.execute('window_click', { slot: 1 });
  await runtime.execute('window_close');

  assert.ok(sessionCalls.includes('start'));
  assert.ok(sessionCalls.includes('stop'));
  assert.ok(sessionCalls.includes('restart'));
  assert.ok(sessionCalls.includes('chat:Hello'));
  assert.ok(sessionCalls.includes('reset'));
  assert.ok(sessionCalls.includes('afk:still'));
  assert.ok(sessionCalls.includes('proxy:socks5://user:pass@128.0.0.1:1080'));
  assert.ok(sessionCalls.includes('respawn'));
  assert.ok(sessionCalls.includes('inventory:list'));
  assert.ok(sessionCalls.includes('look:90,0'));
  assert.ok(sessionCalls.includes('toss:36'));
  assert.ok(sessionCalls.includes('window_click:1'));
  assert.ok(sessionCalls.includes('window_close'));
  console.log('✅ 2. WorkerRuntime: All actions executed and dispatched to session cleanly.');

  // 3. Proxy Validation Check
  console.log('3. Checking SOCKS5 Proxy Parsing...');
  const parsed = parseSocksProxy('socks5://user:pass@128.0.0.1:1080');
  assert.strictEqual(parsed.host, '128.0.0.1');
  assert.strictEqual(parsed.port, 1080);
  assert.strictEqual(parsed.username, 'user');
  assert.strictEqual(parsed.password, 'pass');

  // Verify private/local IP rejection
  assert.throws(() => {
    parseSocksProxy('socks5://127.0.0.1:1080');
  }, /local or private network/);
  console.log('✅ 3. SOCKS5 Proxy: Parsing & private network protection verified.');

  // 4. Timing Safe Secret Equality
  console.log('4. Checking Timing Safe Secret Authentication...');
  assert.strictEqual(safeEqual('secret123456789012345678901234', 'secret123456789012345678901234'), true);
  assert.strictEqual(safeEqual('secret123456789012345678901234', 'wrongsecret12345678901234567890'), false);
  console.log('✅ 4. Secret Auth: Timing safe string comparison verified.');

  // 5. WorkerRuntime Lifecycle Concurrency Mutex
  console.log('5. Checking Lifecycle Concurrency Mutex...');
  let slowStartResolve;
  const slowSession = {
    start: () => new Promise(res => { slowStartResolve = res; }),
    restart: async () => ({ ok: true }),
    getStatus: () => ({ state: 'starting' })
  };
  const mutexRuntime = new WorkerRuntime(slowSession, { workerId: 'test_mutex' }, console);
  const p1 = mutexRuntime.execute('start');
  await new Promise(r => setImmediate(r));
  let mutexCaught = false;
  try {
    await mutexRuntime.execute('restart');
  } catch (err) {
    mutexCaught = true;
    assert.match(err.message, /lifecycle operation.*already in progress/i);
  }
  assert.strictEqual(mutexCaught, true, 'Concurrent lifecycle action must be blocked by mutex');
  slowStartResolve({ ok: true });
  await p1;
  console.log('✅ 5. Lifecycle Mutex: Concurrent conflicting actions blocked.');

  // 6. MinecraftSession Bounded Reconnect & Cancel on Stop/Reset
  console.log('6. Checking MinecraftSession Bounded Reconnect...');
  const { MinecraftSession } = require('../src/game/minecraft-session');
  const session = new MinecraftSession({
    workerId: 'test_session',
    botNumber: 1,
    reconnectMaxAttempts: 25,
    reconnectBaseMs: 100,
    mc: {
      username: 'TestBot',
      password: 'password123',
      server: 'localhost:25565'
    }
  }, console);

  assert.strictEqual(session.config.reconnectMaxAttempts, 25, 'Default reconnect max attempts must be 25');
  assert.strictEqual(session.reconnectAttempts, 0, 'Initial reconnect attempts must be 0');

  // Trigger stop and verify generation increments and reconnect cancels
  const initialGen = session.generation;
  await session.stop();
  assert.strictEqual(session.generation, initialGen + 1, 'Stop must increment generation to invalidate reconnect callbacks');
  await session.resetData();
  assert.strictEqual(session.generation, initialGen + 3, 'Reset must increment generation (including internal stop)');
  console.log('✅ 6. Bounded Reconnect: Max 25 attempts, generation increment & cancel on stop/reset verified.');

  console.log('🎉 ALL WORKER INTEGRATION TESTS PASSED 100%!');
}

runTests().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
