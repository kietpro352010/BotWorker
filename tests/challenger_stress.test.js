'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../src/http/app');
const WispbytePoller = require('../src/transports/wispbyte-poller');
const ManagerReporter = require('../src/transports/manager-reporter');
const WispbyteKeepAlive = require('../src/services/wispbyte-keepalive');
const WorkerRuntime = require('../src/services/worker-runtime');
const WorkerFleet = require('../src/services/worker-fleet');

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runAdversarialChallenges() {
  console.log('=== STARTING EMPIRICAL ADVERSARIAL CHALLENGES ===\n');

  // =========================================================================
  // CHALLENGE 1: poller.stop() cancellableSleep termination timing (< 50ms)
  // =========================================================================
  console.log('--- CHALLENGE 1: poller.stop() cancellableSleep termination timing ---');
  {
    // Test 1.1: Poller enters a deep backoff sleep (simulate failures=5 -> backoff ~48,000-60,000ms).
    // Verify that calling stop() aborts sleep in < 50ms.
    let pollAttempts = 0;
    const mockFetch = async () => {
      pollAttempts += 1;
      const err = new Error('simulated_network_down');
      err.status = 500;
      throw err;
    };

    const poller = new WispbytePoller({
      config: { workerId: 'challenger_poller_1', managerUrl: 'http://manager' },
      runtime: { status: () => ({ state: 'idle' }), execute: async () => ({ ok: true }) },
      reporter: { managerLatencyMs: 15 },
      logger: quietLogger,
      fetchImpl: mockFetch
    });

    poller.failures = 4; // next delay will be >= 24,000ms
    const pollerLoop = poller.start();

    // Give event loop time to enter cancellableSleep in the error handler
    await sleep(30);

    const t0 = Date.now();
    await poller.stop();
    const durationMs = Date.now() - t0;
    await pollerLoop;

    console.log(`  [1.1] Deep backoff sleep (24s-60s) stopped in: ${durationMs}ms`);
    assert.ok(durationMs < 50, `poller.stop() took ${durationMs}ms, expected < 50ms`);
    assert.strictEqual(poller.stopping, true, 'poller.stopping must be true');

    // Test 1.2: Rapid cycle start -> stop -> start -> stop with responsive signal
    for (let i = 0; i < 5; i++) {
      const p = new WispbytePoller({
        config: { workerId: `challenger_rapid_${i}`, managerUrl: 'http://manager' },
        runtime: { status: () => ({ state: 'idle' }), execute: async () => ({ ok: true }) },
        reporter: { managerLatencyMs: 5 },
        logger: quietLogger,
        fetchImpl: async (_url, opts) => {
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ ok: true }) }), 2000);
            opts?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          });
        }
      });
      p.start();
      await sleep(10); // let fetch start
      const tStart = Date.now();
      await p.stop();
      const elapsed = Date.now() - tStart;
      console.log(`    cycle ${i}: stopped in ${elapsed}ms`);
      assert.ok(elapsed < 50, `rapid stop cycle ${i} took ${elapsed}ms, expected < 50ms`);
    }
    console.log('  [1.2] Rapid start/stop cycles completed in < 50ms each');

    // Test 1.3: Calling stop() multiple times concurrently
    const multiStopPoller = new WispbytePoller({
      config: { workerId: 'multi_stop', managerUrl: 'http://manager' },
      runtime: { status: () => ({ state: 'idle' }), execute: async () => ({ ok: true }) },
      reporter: { managerLatencyMs: 5 },
      logger: quietLogger,
      fetchImpl: async () => { throw new Error('fail'); }
    });
    multiStopPoller.start();
    await sleep(20);
    const multiStopStart = Date.now();
    await Promise.all([
      multiStopPoller.stop(),
      multiStopPoller.stop(),
      multiStopPoller.stop()
    ]);
    const multiStopElapsed = Date.now() - multiStopStart;
    console.log(`  [1.3] Concurrent stop() calls resolved in: ${multiStopElapsed}ms`);
    assert.ok(multiStopElapsed < 50, `Concurrent stop took ${multiStopElapsed}ms`);
  }
  console.log('✅ Challenge 1 PASSED: poller.stop() terminates backoff immediately (< 50ms).\n');

  // =========================================================================
  // CHALLENGE 2: Pending-result retry queue & exponential backoff on reconnect
  // =========================================================================
  console.log('--- CHALLENGE 2: Pending-result retry queue & exponential backoff ---');
  {
    // Test 2.1: Bounded queue capacity (max 100 items, drops oldest FIFO)
    const poller = new WispbytePoller({
      config: { workerId: 'challenger_res_queue', managerUrl: 'http://manager' },
      runtime: { status: () => ({ state: 'idle' }) },
      reporter: { managerLatencyMs: 10 },
      logger: quietLogger,
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) })
    });

    for (let i = 0; i < 150; i++) {
      poller.enqueueResult({ commandId: `cmd_${i}`, action: 'chat', result: { ok: true } });
    }
    assert.strictEqual(poller.pendingResults.length, 100, 'Queue must cap at 100 items');
    assert.strictEqual(poller.pendingResults[0].payload.commandId, 'cmd_50', 'Oldest 50 items must be dropped');
    assert.strictEqual(poller.pendingResults[99].payload.commandId, 'cmd_149', 'Newest item must be retained');
    console.log('  [2.1] Queue bounded at 100 items with FIFO eviction verified');

    // Test 2.2: Exponential backoff calculation and retry scheduling on failed POST
    let resultPostCount = 0;
    const deliveredCommands = [];
    let simulateFailure = true;

    const mockFetch = async (url, opts) => {
      if (url.includes('/result')) {
        resultPostCount += 1;
        if (simulateFailure) {
          throw new Error('503 Service Unavailable');
        }
        deliveredCommands.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    };

    const retryPoller = new WispbytePoller({
      config: { workerId: 'retry_poller', managerUrl: 'http://manager' },
      runtime: { status: () => ({ state: 'idle' }) },
      reporter: { managerLatencyMs: 10 },
      logger: quietLogger,
      fetchImpl: mockFetch
    });

    retryPoller.enqueueResult({ commandId: 'retry_cmd_1', action: 'chat', result: { ok: true } });

    // Attempt 1: Fails -> attempts = 1, nextRetryAt set with backoff
    const tBefore1 = Date.now();
    await retryPoller.flushPendingResults();
    assert.strictEqual(resultPostCount, 1);
    assert.strictEqual(retryPoller.pendingResults.length, 1);
    assert.strictEqual(retryPoller.pendingResults[0].attempts, 1);
    // Backoff for attempt 1: 1000 * 2^1 = 2000ms
    const expectedBackoff1 = 2000;
    const actualDiff1 = retryPoller.pendingResults[0].nextRetryAt - tBefore1;
    assert.ok(actualDiff1 >= expectedBackoff1 - 100 && actualDiff1 <= expectedBackoff1 + 500,
      `Backoff 1 was ${actualDiff1}ms, expected ~${expectedBackoff1}ms`);

    // Immediate flush attempt while now < nextRetryAt must SKIP request
    await retryPoller.flushPendingResults();
    assert.strictEqual(resultPostCount, 1, 'Must skip retry before backoff window expires');

    // Attempt 2: Advance time artificially and fail again
    retryPoller.pendingResults[0].nextRetryAt = 0;
    const tBefore2 = Date.now();
    await retryPoller.flushPendingResults();
    assert.strictEqual(resultPostCount, 2);
    assert.strictEqual(retryPoller.pendingResults[0].attempts, 2);
    // Backoff for attempt 2: 1000 * 2^2 = 4000ms
    const expectedBackoff2 = 4000;
    const actualDiff2 = retryPoller.pendingResults[0].nextRetryAt - tBefore2;
    assert.ok(actualDiff2 >= expectedBackoff2 - 100 && actualDiff2 <= expectedBackoff2 + 500,
      `Backoff 2 was ${actualDiff2}ms, expected ~${expectedBackoff2}ms`);

    // Attempt 3: Network recovers! Advance time and flush
    simulateFailure = false;
    retryPoller.pendingResults[0].nextRetryAt = 0;
    await retryPoller.flushPendingResults();
    assert.strictEqual(resultPostCount, 3);
    assert.strictEqual(retryPoller.pendingResults.length, 0, 'Queue must be drained on success');
    assert.strictEqual(deliveredCommands.length, 1);
    assert.strictEqual(deliveredCommands[0].commandId, 'retry_cmd_1');
    console.log('  [2.2] Exponential backoff retry and recovery verified');

    // Test 2.3: flushPendingResults() when stopping is true must be a no-op
    retryPoller.enqueueResult({ commandId: 'cmd_stop', action: 'chat' });
    retryPoller.stopping = true;
    await retryPoller.flushPendingResults();
    assert.strictEqual(retryPoller.pendingResults.length, 1, 'Should not process items when stopping');
    console.log('  [2.3] flushPendingResults respects stopping flag');
  }
  console.log('✅ Challenge 2 PASSED: Pending-result retry queue & backoff verified.\n');

  // =========================================================================
  // CHALLENGE 3: Event reporting queue ACK validation (`body.ok`) and retry
  // =========================================================================
  console.log('--- CHALLENGE 3: Event reporting queue ACK validation & retry ---');
  {
    // Test 3.1: Manager returns HTTP 200 with body.ok = false -> must count as failure and retry
    let eventPostCount = 0;
    let mockResponse = { ok: true, status: 200, json: async () => ({ ok: false, error: 'manager_rejected' }) };

    const reporter = new ManagerReporter({
      baseUrl: 'http://manager',
      workerId: 'challenger_events',
      secret: 'secret_key',
      logger: quietLogger,
      fetchImpl: async () => {
        eventPostCount += 1;
        return mockResponse;
      }
    });

    reporter.enqueueEvent({
      type: 'bot_kicked',
      message: 'Kicked: /login secret_pass_123',
      reason: 'Failed auth password: secret_pass_456',
      password: 'raw_password_to_strip',
      token: 'raw_token_to_strip'
    });

    assert.strictEqual(reporter.eventQueue.length, 1);
    const enqueued = reporter.eventQueue[0].event;
    // Verify stripping and redaction
    assert.strictEqual(enqueued.password, undefined, 'password field must be deleted');
    assert.strictEqual(enqueued.token, undefined, 'token field must be deleted');
    assert.ok(enqueued.message.includes('*** REDACTED ***'), 'sensitive command passwords must be redacted');
    assert.ok(!enqueued.message.includes('secret_pass_123'), 'raw password must not appear in message');
    assert.ok(enqueued.reason.includes('*** REDACTED ***'), 'sensitive reason passwords must be redacted');
    assert.ok(!enqueued.reason.includes('secret_pass_456'), 'raw password must not appear in reason');
    console.log('  [3.1] Credential redaction in event payload verified');

    // Flush 1: Server returned { ok: false } despite HTTP 200
    await reporter.flushEventQueue();
    assert.strictEqual(eventPostCount, 1);
    assert.strictEqual(reporter.eventQueue.length, 1, 'Event must stay in queue when body.ok is false');
    assert.strictEqual(reporter.eventQueue[0].attempts, 1);

    // Flush 2: Switch to HTTP 500 error
    mockResponse = { ok: false, status: 500, json: async () => ({ ok: false, error: 'db_down' }) };
    reporter.eventQueue[0].nextRetryAt = 0;
    await reporter.flushEventQueue();
    assert.strictEqual(eventPostCount, 2);
    assert.strictEqual(reporter.eventQueue.length, 1, 'Event must stay in queue on HTTP 500');
    assert.strictEqual(reporter.eventQueue[0].attempts, 2);

    // Flush 3: Switch to valid ACK { ok: true }
    mockResponse = { ok: true, status: 200, json: async () => ({ ok: true }) };
    reporter.eventQueue[0].nextRetryAt = 0;
    await reporter.flushEventQueue();
    assert.strictEqual(eventPostCount, 3);
    assert.strictEqual(reporter.eventQueue.length, 0, 'Event must be cleared on valid body.ok = true');
    console.log('  [3.2] Non-ACK response ({ ok: false } and 500) trigger retry; ACK ({ ok: true }) drains queue');

    // Test 3.3: Bounded event queue capacity (max 100 items)
    for (let i = 0; i < 150; i++) {
      reporter.enqueueEvent({ type: 'spam', message: `msg_${i}` });
    }
    assert.strictEqual(reporter.eventQueue.length, 100, 'Event queue must cap at 100');
    assert.strictEqual(reporter.eventQueue[0].event.message, 'msg_50', 'Oldest 50 events dropped');
    assert.strictEqual(reporter.eventQueue[99].event.message, 'msg_149', 'Newest event retained');
    console.log('  [3.3] Event queue bounded at 100 items with FIFO eviction verified');

    reporter.stop();
  }
  console.log('✅ Challenge 3 PASSED: Event reporting queue ACK validation & retry verified.\n');

  // =========================================================================
  // CHALLENGE 4: Adversarially test keepalive panel URL (SSRF & HTTP bypass)
  // =========================================================================
  console.log('--- CHALLENGE 4: Keepalive panel URL SSRF & HTTP bypass attempts ---');
  {
    const attackVectors = [
      // Protocol bypass attacks
      { url: 'http://wispbyte.com/client', desc: 'Plain HTTP protocol' },
      { url: 'http://wispbyte.com:443/client', desc: 'HTTP on port 443' },
      { url: 'ftp://wispbyte.com/client', desc: 'FTP protocol' },
      { url: 'file:///etc/passwd', desc: 'File protocol' },
      { url: 'gopher://wispbyte.com', desc: 'Gopher protocol' },
      { url: 'javascript:alert(1)', desc: 'JavaScript pseudo-protocol' },
      { url: 'ws://wispbyte.com', desc: 'WebSocket protocol' },
      { url: 'wss://wispbyte.com', desc: 'WSS protocol (must be HTTPS only)' },

      // SSRF & Domain spoofing attacks
      { url: 'https://wispbyte.com.evil.com/client', desc: 'Subdomain suffix hijack' },
      { url: 'https://evilwispbyte.com/client', desc: 'Prefix similarity spoofing' },
      { url: 'https://wispbyte.com@attacker.com/client', desc: 'Userinfo authority spoofing' },
      { url: 'https://attacker.com#wispbyte.com', desc: 'Fragment authority spoofing' },
      { url: 'https://127.0.0.1/client', desc: 'IPv4 loopback SSRF' },
      { url: 'https://localhost:8443/client', desc: 'Localhost SSRF' },
      { url: 'https://[::1]/client', desc: 'IPv6 loopback SSRF' },
      { url: 'https://169.254.169.254/latest/meta-data', desc: 'AWS metadata SSRF' },
      { url: 'https://10.0.0.1/client', desc: 'Private RFC 1918 (10.x) SSRF' },
      { url: 'https://192.168.1.1/client', desc: 'Private RFC 1918 (192.168.x) SSRF' },
      { url: 'https://0.0.0.0/', desc: '0.0.0.0 wildcard SSRF' },

      // Malformed URLs (non-empty strings that fail URL parsing or protocol checks)
      { url: 'https://', desc: 'Incomplete URL scheme' },
      { url: 'not-a-url', desc: 'Arbitrary text' },
      { url: '://bad', desc: 'Missing scheme' },
      { url: 'https:///path', desc: 'Missing host' }
    ];

    let rejectedCount = 0;
    for (const vector of attackVectors) {
      let fetchCalled = false;
      const keepAlive = new WispbyteKeepAlive({
        cookie: 'session_cookie_123',
        panelUrl: vector.url
      }, quietLogger, {
        fetchImpl: async () => { fetchCalled = true; return { status: 200, text: async () => '' }; }
      });

      assert.strictEqual(keepAlive.enabled, false, `Vector "${vector.desc}" (${vector.url}) must disable keepalive`);
      assert.strictEqual(keepAlive.lastStatus, 'error', `Vector "${vector.desc}" must set lastStatus = error`);

      const pingResult = await keepAlive.ping();
      assert.strictEqual(pingResult.success, false, `Vector "${vector.desc}" ping must fail`);
      assert.strictEqual(fetchCalled, false, `Vector "${vector.desc}" must never trigger network fetch`);
      rejectedCount += 1;
    }
    console.log(`  [4.1] Rejected all ${rejectedCount}/${attackVectors.length} SSRF and bypass vectors without executing fetch`);

    // Valid URLs must pass
    const validUrls = [
      'https://wispbyte.com/client',
      'https://wispbyte.com',
      'https://panel.wispbyte.com/client',
      'https://sub.panel.wispbyte.com/dashboard',
      'https://wispbyte.com:8443/client'
    ];

    for (const validUrl of validUrls) {
      let fetchUrl = null;
      const keepAlive = new WispbyteKeepAlive({
        cookie: 'valid_cookie',
        panelUrl: validUrl
      }, quietLogger, {
        fetchImpl: async (u) => {
          fetchUrl = u;
          return { status: 200, text: async () => '<html>servers logout</html>', headers: new Map() };
        }
      });
      assert.strictEqual(keepAlive.enabled, true, `Valid URL ${validUrl} must be enabled`);
      const pingRes = await keepAlive.ping();
      assert.strictEqual(pingRes.success, true, `Valid URL ${validUrl} ping must succeed`);
      assert.strictEqual(fetchUrl, validUrl, `Fetch URL must match configured valid URL`);
    }
    // Empty or omitted panelUrl defaults to safe DEFAULT_PANEL_URL (https://wispbyte.com/client)
    const defaultKeepAlive = new WispbyteKeepAlive({
      cookie: 'valid_cookie'
    }, quietLogger);
    assert.strictEqual(defaultKeepAlive.enabled, true);
    assert.strictEqual(defaultKeepAlive.panelUrl, 'https://wispbyte.com/client');
    console.log('  [4.3] Omitted panelUrl safely defaults to https://wispbyte.com/client');
  }
  console.log('✅ Challenge 4 PASSED: Keepalive panel URL SSRF & HTTP bypass prevention verified.\n');

  // =========================================================================
  // CHALLENGE 5: Stress test HTTP error mappings (400, 413, 409, 429, 503, 504)
  // =========================================================================
  console.log('--- CHALLENGE 5: Stress test HTTP error mappings ---');
  {
    let injectedError = null;
    const mockInstance = {
      config: { workerId: 'w_test', secret: 'test_secret' },
      runtime: {
        execute: async () => {
          if (injectedError) throw injectedError;
          return { ok: true, resultData: 123 };
        },
        status: () => ({ state: 'online' })
      }
    };

    const app = createApp({
      fleet: {
        get: (id) => (id === 'w_test' ? mockInstance : null),
        list: () => [mockInstance],
        health: () => ({})
      },
      config: { botCount: 1, bots: [mockInstance.config] },
      logger: quietLogger
    });

    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 5.1: Malformed JSON -> 400 invalid_json
      const rBadJson = await fetch(`${baseUrl}/api/v1/bots/w_test/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret' },
        body: '{"action": "chat", '
      });
      assert.strictEqual(rBadJson.status, 400);
      const bBadJson = await rBadJson.json();
      assert.strictEqual(bBadJson.error, 'invalid_json');
      console.log('  [5.1] Malformed JSON -> 400 invalid_json verified');

      // 5.2: Payload > 32kb -> 413 payload_too_large
      const rHuge = await fetch(`${baseUrl}/api/v1/bots/w_test/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret' },
        body: JSON.stringify({ action: 'chat', payload: { data: 'A'.repeat(35000) } })
      });
      assert.strictEqual(rHuge.status, 413);
      const bHuge = await rHuge.json();
      assert.strictEqual(bHuge.error, 'payload_too_large');
      console.log('  [5.2] Body > 32kb -> 413 payload_too_large verified');

      // 5.3: Unsupported action -> 400 unsupported_action
      const rBadAction = await fetch(`${baseUrl}/api/v1/bots/w_test/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret' },
        body: JSON.stringify({ action: 'nonexistent_action' })
      });
      assert.strictEqual(rBadAction.status, 400);
      const bBadAction = await rBadAction.json();
      assert.strictEqual(bBadAction.error, 'unsupported_action');
      console.log('  [5.3] Unsupported action -> 400 unsupported_action verified');

      // Helper for testing injected command errors
      const postCommand = async (action = 'status') => {
        return fetch(`${baseUrl}/api/v1/bots/w_test/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-worker-secret': 'test_secret' },
          body: JSON.stringify({ action, payload: {} })
        });
      };

      // 5.4: Lifecycle conflict -> 409
      injectedError = Object.assign(new Error('Conflicting stop command rejected'), { code: 'LIFECYCLE_CONFLICT' });
      const r409 = await postCommand('stop');
      assert.strictEqual(r409.status, 409);
      console.log('  [5.4] Lifecycle conflict -> 409 verified');

      // 5.5: Rate limit reached -> 429
      injectedError = Object.assign(new Error('Rate limit reached'), { code: 'RATE_LIMIT' });
      const r429 = await postCommand('status');
      assert.strictEqual(r429.status, 429);
      console.log('  [5.5] Rate limit -> 429 verified');

      // 5.6: Queue busy -> 503
      injectedError = Object.assign(new Error('Queue is busy'), { code: 'QUEUE_BUSY' });
      const r503 = await postCommand('status');
      assert.strictEqual(r503.status, 503);
      console.log('  [5.6] Queue busy -> 503 verified');

      // 5.7: Command timeout -> 504
      injectedError = Object.assign(new Error('Execution timed out'), { code: 'ETIMEDOUT' });
      const r504 = await postCommand('status');
      assert.strictEqual(r504.status, 504);
      console.log('  [5.7] Execution timeout -> 504 verified');

      // 5.8: Auth error -> 401
      const r401 = await fetch(`${baseUrl}/api/v1/bots/w_test/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-secret': 'WRONG_SECRET' },
        body: JSON.stringify({ action: 'status' })
      });
      assert.strictEqual(r401.status, 401);
      console.log('  [5.8] Invalid secret -> 401 verified');
    } finally {
      server.close();
    }
  }
  console.log('✅ Challenge 5 PASSED: HTTP error mappings verified.\n');

  // =========================================================================
  // CHALLENGE 6: Stress test rate limit quota (rejected commands don't deduct)
  // =========================================================================
  console.log('--- CHALLENGE 6: Stress test rate limit quota deduction ---');
  {
    const session = {
      sendChat: async () => ({ ok: true }),
      getStatus: () => ({ state: 'online' })
    };

    const runtime = new WorkerRuntime(session, {
      workerId: 'challenger_ratelimit',
      commandTimeoutMs: 1000
    }, quietLogger);

    // Initial quota check: commandTimes must be 0
    assert.strictEqual(runtime.commandTimes.length, 0);

    // Blast 50 rejected commands that fail validation / conflict:
    // 10 with unsupported action
    for (let i = 0; i < 10; i++) {
      await assert.rejects(runtime.execute('bogus_action'), /Unsupported worker action/);
    }
    // 10 with invalid payload (not object)
    for (let i = 0; i < 10; i++) {
      await assert.rejects(runtime.execute('chat', 'string_payload'), /payload must be an object/);
    }
    // 10 with oversized payload
    const bigPayload = { spam: 'X'.repeat(5000) };
    for (let i = 0; i < 10; i++) {
      await assert.rejects(runtime.execute('chat', bigPayload), /payload is too large/);
    }
    // 10 with pre-aborted signal
    const ac = new AbortController();
    ac.abort(new Error('pre_aborted'));
    for (let i = 0; i < 10; i++) {
      await assert.rejects(runtime.execute('chat', {}, { signal: ac.signal }), /pre_aborted/);
    }
    // 10 with simulated active lifecycle conflict
    runtime.activeLifecycle = 'start';
    for (let i = 0; i < 10; i++) {
      await assert.rejects(runtime.execute('stop'), /conflicting stop command rejected/i);
    }
    runtime.activeLifecycle = null;

    // VERIFY: None of the 50 rejected commands deducted rate limit quota!
    assert.strictEqual(runtime.commandTimes.length, 0,
      `Expected 0 recorded commands, but found ${runtime.commandTimes.length}`);
    console.log('  [6.1] 50 rejected commands produced 0 deductions in commandTimes');

    // Now issue 30 legitimate commands: they should all succeed up to the limit of 30/min
    for (let i = 0; i < 30; i++) {
      const res = await runtime.execute('chat', { message: `msg_${i}` });
      assert.strictEqual(res.ok, true);
    }
    assert.strictEqual(runtime.commandTimes.length, 30, 'All 30 admitted commands deducted quota');
    console.log('  [6.2] All 30 legitimate commands admitted and quota recorded');

    // Command 31 must be blocked by RATE_LIMIT
    await assert.rejects(
      runtime.execute('chat', { message: 'overflow_31' }),
      (err) => err.code === 'RATE_LIMIT'
    );
    console.log('  [6.3] Command 31 correctly rejected with RATE_LIMIT');
  }
  console.log('✅ Challenge 6 PASSED: Rate limit quota deduction on rejection verified.\n');

  // =========================================================================
  // CHALLENGE 7: Stress test fleet concurrency (duplicate timer prevention)
  // =========================================================================
  console.log('--- CHALLENGE 7: Stress test fleet concurrency & duplicate timers ---');
  {
    let bootstrapCalls = 0;
    const fleet = new WorkerFleet({
      autoStart: false,
      bots: [{
        workerId: 'challenger_fleet_bot_1',
        managerUrl: 'http://manager',
        secret: 'sec1',
        transport: 'render-http',
        mc: { username: 'Bot1' }
      }, {
        workerId: 'challenger_fleet_bot_2',
        managerUrl: 'http://manager',
        secret: 'sec2',
        transport: 'render-http',
        mc: { username: 'Bot2' }
      }],
      wispbyte: {}
    }, quietLogger, {
      fetchImpl: async (url) => {
        if (url.includes('/bootstrap')) {
          bootstrapCalls += 1;
          await sleep(15);
          return { ok: true, json: async () => ({ ok: true, settings: {}, credentials: {} }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      }
    });

    // Run 10 concurrent start calls
    console.log('  [7.1] Launching 10 concurrent fleet.start() calls...');
    await Promise.all(Array.from({ length: 10 }, () => fleet.start()));

    assert.strictEqual(fleet.state, 'RUNNING');
    const firstHbTimer = fleet.heartbeatTimer;
    const firstResTimer = fleet.resourceTimer;
    assert.ok(firstHbTimer !== null, 'heartbeatTimer must be initialized');
    assert.ok(firstResTimer !== null, 'resourceTimer must be initialized');

    // Run another 5 start calls while running: should be no-ops
    await Promise.all(Array.from({ length: 5 }, () => fleet.start()));
    assert.strictEqual(fleet.heartbeatTimer, firstHbTimer, 'heartbeatTimer must remain unchanged');
    assert.strictEqual(fleet.resourceTimer, firstResTimer, 'resourceTimer must remain unchanged');
    console.log('  [7.2] Verified exactly one set of timers created; duplicate starts ignored');

    // Concurrently call fleet.stop()
    console.log('  [7.3] Launching 5 concurrent fleet.stop() calls...');
    await Promise.all(Array.from({ length: 5 }, () => fleet.stop()));

    assert.strictEqual(fleet.state, 'STOPPED');
    assert.strictEqual(fleet.heartbeatTimer, null, 'heartbeatTimer must be null after stop');
    assert.strictEqual(fleet.resourceTimer, null, 'resourceTimer must be null after stop');
    console.log('  [7.4] Timers cleanly cleared on stop');

    // Restart fleet again after stopping to verify reusability without leaking
    await fleet.start();
    assert.strictEqual(fleet.state, 'RUNNING');
    assert.ok(fleet.heartbeatTimer !== null);
    await fleet.stop();
    assert.strictEqual(fleet.state, 'STOPPED');
    console.log('  [7.5] Fleet restarted and stopped cleanly');
  }
  console.log('✅ Challenge 7 PASSED: Fleet concurrency & timer leak prevention verified.\n');

  // =========================================================================
  // CHALLENGE 8: RT-14-01 & RT-14-02 Task timeout lock & lifecycle conflict
  // =========================================================================
  console.log('--- CHALLENGE 8: RT-14-01 & RT-14-02 Task timeout lock & lifecycle conflict ---');
  {
    // Test 8.1: Timed-out non-lifecycle task retains execution lock until finished
    let task1Finished = false;
    let task2StartedDuringTask1 = false;
    let task1Started = false;

    const session = {
      sendChat: async (msg) => {
        if (msg === 'task1_slow') {
          task1Started = true;
          await sleep(100);
          task1Finished = true;
          return { ok: true };
        }
        if (msg === 'task2_subsequent') {
          if (task1Started && !task1Finished) {
            task2StartedDuringTask1 = true;
          }
          return { ok: true };
        }
        return { ok: true };
      },
      abortPending: () => {},
      getStatus: () => ({ state: 'online' })
    };

    const runtime = new WorkerRuntime(session, {
      workerId: 'w_timeout_lock',
      commandTimeoutMs: 25
    }, quietLogger);

    // Launch task1 (will time out after 25ms, but runs for 100ms)
    const p1 = runtime.execute('chat', { message: 'task1_slow' });
    await assert.rejects(p1, /timed out after 25ms/i);
    assert.strictEqual(task1Finished, false, 'Task 1 must still be running in background after timeout');

    // Launch task2 immediately after task1 timeout
    const p2 = runtime.execute('chat', { message: 'task2_subsequent' });
    await p2;

    assert.strictEqual(task1Finished, true, 'Task 1 must have completed before task 2 was allowed to run');
    assert.strictEqual(task2StartedDuringTask1, false, 'Task 2 must never run concurrently with timed-out task 1');
    console.log('  [8.1] Non-lifecycle task timeout retains execution lock preventing concurrency violation');

    // Test 8.2: Queued lifecycle conflict rejects immediately
    let longChatDone = false;
    const session2 = {
      sendChat: async () => {
        await sleep(80);
        longChatDone = true;
        return { ok: true };
      },
      stop: async () => ({ state: 'stopped' }),
      restart: async () => ({ state: 'online' }),
      getStatus: () => ({ state: 'online' })
    };

    const runtime2 = new WorkerRuntime(session2, {
      workerId: 'w_queued_conflict'
    }, quietLogger);

    // Start long chat command
    const pChat = runtime2.execute('chat', { message: 'long' });
    await sleep(10); // Chat is executing

    // Queue 'stop' command (it waits for chat to finish)
    const pStop = runtime2.execute('stop');
    assert.strictEqual(runtime2.getQueuedLifecycleAction(), 'stop');

    // Send 'restart' command while 'stop' is queued -> must reject immediately with LIFECYCLE_CONFLICT!
    await assert.rejects(
      runtime2.execute('restart'),
      (err) => err.code === 'LIFECYCLE_CONFLICT' && /lifecycle operation \(stop\) is already in progress/i.test(err.message)
    );
    console.log('  [8.2] Conflicting lifecycle command rejected immediately when another lifecycle is queued');

    await Promise.all([pChat, pStop]);
  }
  console.log('✅ Challenge 8 PASSED: Task timeout lock retention & queued lifecycle conflict verified.\n');

  console.log('======================================================');
  console.log('🎉 ALL 8 ADVERSARIAL CHALLENGES COMPLETED & PASSED 100%!');
  console.log('======================================================\n');
}

runAdversarialChallenges().catch((err) => {
  console.error('\n❌ ADVERSARIAL CHALLENGE FAILED:', err);
  process.exit(1);
});
