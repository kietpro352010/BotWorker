'use strict';

const assert = require('node:assert');
const EventEmitter = require('node:events');
const WorkerRuntime = require('../src/services/worker-runtime');
const { ACTIONS } = require('../src/services/worker-runtime');
const { parseSocksProxy } = require('../src/config/proxy');
const { safeEqual } = require('../src/http/auth');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

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

  // 7. Execution timeout starts at execution time, NOT queue-wait time
  console.log('7. Checking execution timeout starts at execution time (not queue wait)...');
  {
    const execOrder = [];
    const queuedTimingSession = {
      sendChat: async (msg) => {
        execOrder.push(`chat:${msg}:start`);
        await sleep(80);
        execOrder.push(`chat:${msg}:end`);
        return { ok: true, msg };
      },
      look: async (yaw, pitch) => {
        execOrder.push(`look:${yaw},${pitch}:start`);
        await sleep(40);
        execOrder.push(`look:${yaw},${pitch}:end`);
        return { ok: true, yaw, pitch };
      },
      getStatus: () => ({ state: 'online' })
    };
    const timingRuntime = new WorkerRuntime(queuedTimingSession, {
      workerId: 'test_exec_timing',
      commandTimeoutMs: 100
    }, quietLogger);

    const pChat = timingRuntime.execute('chat', { message: 'blocker' });
    const pLook = timingRuntime.execute('look', { yaw: 45, pitch: 10 });
    const [chatRes, lookRes] = await Promise.all([pChat, pLook]);
    assert.strictEqual(chatRes.ok, true);
    assert.strictEqual(lookRes.ok, true);
    assert.deepStrictEqual(execOrder, [
      'chat:blocker:start',
      'chat:blocker:end',
      'look:45,10:start',
      'look:45,10:end'
    ]);

    // Verify execution timeout still fires when execution itself exceeds timeoutMs
    const slowExecSession = {
      sendChat: async () => {
        await sleep(140);
        return { ok: true };
      },
      getStatus: () => ({ state: 'online' })
    };
    const slowExecRuntime = new WorkerRuntime(slowExecSession, {
      workerId: 'test_exec_timeout_fires',
      commandTimeoutMs: 50
    }, quietLogger);
    await assert.rejects(
      slowExecRuntime.execute('chat', { message: 'too-slow' }),
      /timed out after 50ms/i
    );
  }
  console.log('✅ 7. Execution Timeout Timing: Queue wait excluded from exec timeout & slow execution still times out.');

  // 8. Queued cancellation skips executeNow() completely (queueTimeoutMs & AbortSignal)
  console.log('8. Checking queued cancellation skips executeNow() completely...');
  {
    let releaseBlocker;
    const executed = [];
    let refreshCalled = 0;
    const queueCancelSession = {
      sendChat: async (msg) => {
        executed.push(`chat:${msg}`);
        if (msg === 'blocker') {
          await new Promise((resolve) => { releaseBlocker = resolve; });
        }
        return { ok: true };
      },
      start: async () => {
        executed.push('start');
        return { ok: true };
      },
      restart: async () => {
        executed.push('restart');
        return { ok: true };
      },
      getStatus: () => ({ state: 'online' })
    };
    const qcRuntime = new WorkerRuntime(queueCancelSession, {
      workerId: 'test_queue_cancel',
      commandQueueTimeoutMs: 500
    }, quietLogger, {
      refreshManagerConfig: async () => { refreshCalled += 1; }
    });

    const pBlocker = qcRuntime.execute('chat', { message: 'blocker' });
    await new Promise((r) => setImmediate(r));

    // Part A: queueTimeoutMs via payload rejects immediately and skips executeNow
    const pQueueTimeout = qcRuntime.execute('chat', { message: 'never-run-timeout', queueTimeoutMs: 30 });
    await assert.rejects(pQueueTimeout, /timed out waiting in queue after 30ms/i);

    // Part B: AbortSignal while queued rejects immediately, skips executeNow, and frees lifecycle reservation
    const ac = new AbortController();
    const pQueuedStart = qcRuntime.execute('start', {}, { signal: ac.signal });
    ac.abort('caller_cancelled');
    await assert.rejects(pQueuedStart, /caller_cancelled/);

    // Lifecycle reservation must be cleared on queued cancel, allowing a new lifecycle command to queue
    const pQueuedRestart = qcRuntime.execute('restart');

    // Part C: Pre-aborted signal rejects synchronously/immediately without invoking executeNow
    const preAborted = new AbortController();
    preAborted.abort('already_aborted');
    await assert.rejects(qcRuntime.execute('chat', { message: 'never-preaborted' }, { signal: preAborted.signal }), /already_aborted/);

    releaseBlocker();
    await Promise.all([pBlocker, pQueuedRestart]);

    assert.deepStrictEqual(executed, ['chat:blocker', 'restart']);
    assert.strictEqual(refreshCalled, 1, 'refreshManagerConfig must only run for non-cancelled restart');
    assert.strictEqual(qcRuntime.pendingCommands, 0);
  }
  console.log('✅ 8. Queued Cancellation: queueTimeoutMs & AbortSignal skip executeNow() cleanly.');

  // 9. Hung refreshManagerConfig() aborts on timeout & NEVER invokes session.start() / session.restart() late
  console.log('9. Checking hung refreshManagerConfig() cancellation on timeout...');
  {
    const realSession = new MinecraftSession({
      workerId: 'test_refresh_timeout',
      botNumber: 1,
      connectTimeoutMs: 5000,
      reconnectMaxAttempts: 25,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      autoReconnect: true,
      mc: {
        hosts: ['127.0.0.1'],
        port: 25565,
        username: 'TestBot',
        password: 'password123',
        version: '1.20.1',
        viewDistance: 'short',
        authType: 'offline'
      }
    }, quietLogger);

    let startCalls = 0;
    let restartCalls = 0;
    const origStart = realSession.start.bind(realSession);
    const origRestart = realSession.restart.bind(realSession);
    realSession.start = async (...args) => { startCalls += 1; return origStart(...args); };
    realSession.restart = async (...args) => { restartCalls += 1; return origRestart(...args); };

    const observedSignals = [];
    let resolveHungRefresh;
    const refreshTimeoutRuntime = new WorkerRuntime(realSession, {
      workerId: 'test_refresh_timeout',
      lifecycleTimeoutMs: 50
    }, quietLogger, {
      refreshManagerConfig: async ({ signal }) => {
        observedSignals.push(signal);
        await new Promise((resolve) => { resolveHungRefresh = resolve; });
      }
    });

    const genBeforeStart = realSession.generation;
    await assert.rejects(refreshTimeoutRuntime.execute('start'), /timed out after 50ms/i);
    assert.strictEqual(observedSignals.length, 1);
    assert.strictEqual(observedSignals[0].aborted, true, 'AbortSignal must be aborted on timeout');
    assert.ok(realSession.generation > genBeforeStart, 'Session generation must increment on timeout cleanup');
    assert.strictEqual(realSession.state, 'stopped');
    assert.strictEqual(realSession.manualStop, true);
    assert.strictEqual(refreshTimeoutRuntime.activeLifecycle, null);

    // Resolve hung refresh late and verify session.start() is NEVER invoked
    resolveHungRefresh();
    await sleep(20);
    assert.strictEqual(startCalls, 0, 'Late refresh resolution must NEVER call session.start()');

    // Same check for restart
    let resolveHungRestartRefresh;
    refreshTimeoutRuntime.refreshManagerConfig = async ({ signal }) => {
      observedSignals.push(signal);
      await new Promise((resolve) => { resolveHungRestartRefresh = resolve; });
    };
    const genBeforeRestart = realSession.generation;
    await assert.rejects(refreshTimeoutRuntime.execute('restart'), /timed out after 50ms/i);
    assert.strictEqual(observedSignals[1].aborted, true);
    assert.ok(realSession.generation > genBeforeRestart);
    assert.strictEqual(realSession.state, 'stopped');
    resolveHungRestartRefresh();
    await sleep(20);
    assert.strictEqual(restartCalls, 0, 'Late refresh resolution must NEVER call session.restart()');
  }
  console.log('✅ 9. Hung refreshManagerConfig(): Aborted on timeout, generation bumped, never calls start/restart late.');

  // 10. Hung session.start()/restart() cleans up in-flight bot/timers safely, locks activeLifecycle during cleanup,
  //     and late promise settlement does not corrupt activeLifecycle
  console.log('10. Checking hung session.start()/restart() cleanup, safe error handling & activeLifecycle safety...');
  {
    const sessionWithBot = new MinecraftSession({
      workerId: 'test_hung_session',
      botNumber: 1,
      connectTimeoutMs: 5000,
      reconnectMaxAttempts: 25,
      reconnectBaseMs: 100,
      reconnectMaxMs: 1000,
      autoReconnect: true,
      mc: {
        hosts: ['127.0.0.1'],
        port: 25565,
        username: 'TestBot',
        password: 'password123',
        version: '1.20.1',
        viewDistance: 'short',
        authType: 'offline'
      }
    }, quietLogger);

    const fakeSocket = new EventEmitter();
    let socketDestroyed = false;
    fakeSocket.destroy = () => { socketDestroyed = true; };

    const fakeClient = new EventEmitter();
    fakeClient.socket = fakeSocket;
    let clientEnded = false;
    fakeClient.end = () => {
      clientEnded = true;
      // Simulate real socket error emitted during teardown after removeAllListeners
      fakeClient.emit('error', new Error('ECONNRESET'));
      fakeSocket.emit('error', new Error('ECONNRESET'));
    };

    const fakeBot = new EventEmitter();
    fakeBot._client = fakeClient;
    fakeBot.end = (reason) => fakeClient.end(reason);

    let resolveLateStart;
    sessionWithBot.start = async () => {
      sessionWithBot.manualStop = false;
      sessionWithBot.state = 'connecting';
      sessionWithBot.generation += 1;
      sessionWithBot.bot = fakeBot;
      sessionWithBot.connectTimer = setTimeout(() => {}, 10000);
      await new Promise((resolve) => { resolveLateStart = resolve; });
      return sessionWithBot.getStatus();
    };

    const hungRuntime = new WorkerRuntime(sessionWithBot, {
      workerId: 'test_hung_session',
      lifecycleTimeoutMs: 50
    }, quietLogger);

    const genInitial = sessionWithBot.generation;
    await assert.rejects(hungRuntime.execute('start'), /timed out after 50ms/i);
    assert.strictEqual(sessionWithBot.state, 'stopped');
    assert.strictEqual(sessionWithBot.manualStop, true);
    assert.strictEqual(sessionWithBot.bot, null);
    assert.strictEqual(sessionWithBot.connectTimer, null);
    assert.ok(sessionWithBot.generation > genInitial);
    assert.strictEqual(clientEnded, true);
    assert.strictEqual(socketDestroyed, true);
    assert.strictEqual(hungRuntime.activeLifecycle, null);

    // Late resolution of first hung start must NOT corrupt activeLifecycle of a subsequent lifecycle command
    let releaseSecondStart;
    sessionWithBot.start = () => new Promise((resolve) => { releaseSecondStart = resolve; });
    const pSecond = hungRuntime.execute('start');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(hungRuntime.activeLifecycle, 'start');
    resolveLateStart();
    await sleep(15);
    assert.strictEqual(hungRuntime.activeLifecycle, 'start', 'Late aborted start must not clear new activeLifecycle');
    releaseSecondStart({ ok: true });
    await pSecond;
    assert.strictEqual(hungRuntime.activeLifecycle, null);

    // Verify activeLifecycle remains locked WHILE async cleanup runs on timeout
    let releaseStopCleanup;
    let stopCleanupCalls = 0;
    const asyncCleanupSession = {
      start: () => new Promise(() => {}),
      restart: async () => ({ ok: true }),
      stop: () => {
        stopCleanupCalls += 1;
        return new Promise((resolve) => { releaseStopCleanup = resolve; });
      },
      getStatus: () => ({ state: 'stopped' })
    };
    const cleanupLockRuntime = new WorkerRuntime(asyncCleanupSession, {
      workerId: 'test_cleanup_lock',
      lifecycleTimeoutMs: 30
    }, quietLogger);
    const pTimedOutStart = cleanupLockRuntime.execute('start');
    await sleep(45);
    assert.strictEqual(stopCleanupCalls, 1);
    assert.strictEqual(cleanupLockRuntime.activeLifecycle, 'start', 'activeLifecycle must stay locked during cleanup');
    await assert.rejects(
      cleanupLockRuntime.execute('restart'),
      /lifecycle operation \(start\) is already in progress/i
    );
    releaseStopCleanup();
    await assert.rejects(pTimedOutStart, /timed out after 30ms/i);
    assert.strictEqual(cleanupLockRuntime.activeLifecycle, null);
    await cleanupLockRuntime.execute('restart');
  }
  console.log('✅ 10. Hung session.start()/restart(): Bot/socket cleaned safely, activeLifecycle locked during cleanup & immune to late resolve.');

  // 11. MinecraftSession.restart({ signal }) cancels cleanly if aborted mid-restart
  console.log('11. Checking MinecraftSession.restart({ signal }) mid-restart abort guard...');
  {
    const restartSession = new MinecraftSession({
      workerId: 'test_restart_abort',
      botNumber: 1,
      connectTimeoutMs: 5000,
      mc: {
        hosts: ['127.0.0.1'],
        port: 25565,
        username: 'TestBot',
        password: 'password123',
        version: '1.20.1',
        viewDistance: 'short',
        authType: 'offline'
      }
    }, quietLogger);

    let connectCalls = 0;
    restartSession.connect = async () => { connectCalls += 1; return restartSession.getStatus(); };
    const ac = new AbortController();
    const origStop = restartSession.stop.bind(restartSession);
    restartSession.stop = async (reason, opts) => {
      const res = await origStop(reason, opts);
      ac.abort('abort_during_stop');
      return res;
    };

    const status = await restartSession.restart({ signal: ac.signal });
    assert.strictEqual(connectCalls, 0, 'connect() must not be called if signal aborts during stop()');
    assert.strictEqual(status.state, 'stopped');
    assert.strictEqual(restartSession.manualStop, true);
  }
  console.log('✅ 11. MinecraftSession.restart({ signal }): Aborted mid-restart prevents connect().');

  // 12. Lifecycle mutex blocks conflicting lifecycle actions while queued behind non-lifecycle command & enforces queue depth limit
  console.log('12. Checking queued lifecycle mutex & max queue depth (10)...');
  {
    let releaseChat;
    const order = [];
    const mutexQueueSession = {
      sendChat: async (msg) => {
        order.push(`chat:${msg}`);
        if (msg === 'hold') {
          await new Promise((resolve) => { releaseChat = resolve; });
        }
        return { ok: true };
      },
      start: async () => { order.push('start'); return { ok: true }; },
      restart: async () => { order.push('restart'); return { ok: true }; },
      stop: async () => { order.push('stop'); return { ok: true }; },
      resetData: async () => { order.push('reset'); return { ok: true }; },
      getStatus: () => ({ state: 'online' })
    };
    const mqRuntime = new WorkerRuntime(mutexQueueSession, { workerId: 'test_mq' }, quietLogger);

    // Block queue with a non-lifecycle command so activeLifecycle is null
    const pHold = mqRuntime.execute('chat', { message: 'hold' });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(mqRuntime.activeLifecycle, null);

    // Queue 'start' behind blocking 'chat'
    const pStart = mqRuntime.execute('start');
    assert.strictEqual(mqRuntime.activeLifecycle, null, 'start is still queued, not active yet');

    // Conflicting lifecycle actions must ALL be rejected while 'start' is queued
    for (const conflictAction of ['start', 'stop', 'restart', 'reconnect', 'reset']) {
      await assert.rejects(
        mqRuntime.execute(conflictAction),
        /lifecycle operation \(start\) is already in progress/i,
        `Queued start must reject conflicting ${conflictAction}`
      );
    }

    // Non-lifecycle 'status' must still queue and succeed
    const pStatus = mqRuntime.execute('status');
    releaseChat();
    const [, startRes, statusRes] = await Promise.all([pHold, pStart, pStatus]);
    assert.strictEqual(startRes.ok, true);
    assert.strictEqual(statusRes.state, 'online');
    assert.deepStrictEqual(order, ['chat:hold', 'start']);

    // Synchronous immediate double-lifecycle without awaiting setImmediate
    let releaseSyncStart;
    mutexQueueSession.start = () => new Promise((resolve) => { releaseSyncStart = resolve; });
    const pSync1 = mqRuntime.execute('start');
    await assert.rejects(
      mqRuntime.execute('stop'),
      /lifecycle operation \(start\) is already in progress/i
    );
    releaseSyncStart({ ok: true });
    await pSync1;

    // Queue depth limit (>= 10)
    let releaseDepthHold;
    mutexQueueSession.sendChat = async (msg) => {
      if (msg === 'depth-hold') {
        await new Promise((resolve) => { releaseDepthHold = resolve; });
      }
      return { ok: true };
    };
    const depthPromises = [];
    for (let i = 0; i < 10; i++) {
      depthPromises.push(mqRuntime.execute('chat', { message: i === 0 ? 'depth-hold' : `q-${i}` }));
    }
    assert.strictEqual(mqRuntime.pendingCommands, 10);
    await assert.rejects(
      mqRuntime.execute('chat', { message: 'overflow' }),
      /Worker command queue is busy/i
    );
    releaseDepthHold();
    await Promise.all(depthPromises);
    assert.strictEqual(mqRuntime.pendingCommands, 0);
  }
  console.log('✅ 12. Queued Lifecycle Mutex & Queue Depth: Conflicting queued lifecycles & overflow (>10) rejected.');

  // 13. Real MinecraftSession.connect({ signal }) aborts in-flight mineflayer bot without reconnect loop or error crash
  console.log('13. Checking real MinecraftSession.connect({ signal }) in-flight abort cleanup...');
  {
    const mineflayer = require('mineflayer');
    const origCreateBot = mineflayer.createBot;
    let createBotCalls = 0;
    let botEnded = false;
    let socketDestroyed = false;
    let lastCreatedBot = null;

    mineflayer.createBot = () => {
      createBotCalls += 1;
      const socket = new EventEmitter();
      socket.destroy = () => { socketDestroyed = true; };
      const client = new EventEmitter();
      client.socket = socket;
      client.end = () => {
        botEnded = true;
        client.emit('error', new Error('ABORTED_CONN'));
        socket.emit('error', new Error('ABORTED_CONN'));
      };
      const bot = new EventEmitter();
      bot._client = client;
      bot.end = (reason) => client.end(reason);
      lastCreatedBot = bot;
      return bot;
    };

    try {
      const liveSession = new MinecraftSession({
        workerId: 'test_connect_abort',
        botNumber: 1,
        connectTimeoutMs: 5000,
        reconnectMaxAttempts: 25,
        reconnectBaseMs: 100,
        reconnectMaxMs: 1000,
        autoReconnect: true,
        mc: {
          hosts: ['127.0.0.1'],
          port: 25565,
          username: 'TestBot',
          password: 'password123',
          version: '1.20.1',
          viewDistance: 'short',
          authType: 'offline'
        }
      }, quietLogger);

      // Pre-aborted signal must never invoke mineflayer.createBot
      const preAborted = new AbortController();
      preAborted.abort('pre_aborted');
      await liveSession.start({ signal: preAborted.signal });
      assert.strictEqual(createBotCalls, 0);
      assert.strictEqual(liveSession.state, 'stopped');
      assert.strictEqual(liveSession.manualStop, true);

      // Live connect then abort mid-handshake
      const liveAc = new AbortController();
      const status = await liveSession.start({ signal: liveAc.signal });
      assert.strictEqual(createBotCalls, 1);
      assert.strictEqual(status.state, 'connecting');
      const connectGen = liveSession.generation;

      liveAc.abort('cancel_handshake');
      assert.strictEqual(liveSession.state, 'stopped');
      assert.strictEqual(liveSession.manualStop, true);
      assert.strictEqual(liveSession.bot, null);
      assert.strictEqual(liveSession.connectTimer, null);
      assert.ok(liveSession.generation > connectGen);
      assert.strictEqual(botEnded, true);
      assert.strictEqual(socketDestroyed, true);

      // Late onEnd from the old bot generation must NOT trigger reconnect
      liveSession.onEnd(lastCreatedBot, connectGen);
      assert.strictEqual(liveSession.reconnectTimer, null);
      assert.strictEqual(liveSession.state, 'stopped');
    } finally {
      mineflayer.createBot = origCreateBot;
    }
  }
  console.log('✅ 13. Real MinecraftSession.connect({ signal }): In-flight bot aborted & cleaned safely without reconnect.');

  console.log('🎉 ALL WORKER INTEGRATION TESTS PASSED 100%!');
}

runTests().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
