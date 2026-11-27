'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
const { loadConfig } = require('../src/config/env');
const WorkerFleet = require('../src/services/worker-fleet');
const ManagerReporter = require('../src/transports/manager-reporter');
const WispbytePoller = require('../src/transports/wispbyte-poller');
const { DEFAULT_MANAGER_URL } = require('../src/transports/manager-urls');
const { workerFetch, closeWorkerHttpAgents, computeUrlsSignature } = require('../src/transports/http-client');
const { createApp } = require('../src/http/app');

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

async function run() {
  console.log('--- [MULTI-MANAGER & ID-ONLY WORKER REGRESSION TESTS] ---');

  // 1. loadConfig works WITHOUT MANAGER_URL and WITHOUT WORKER_SECRET_1/2
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbot-worker-multi-'));
  const cacheFile = path.join(tempDir, 'kbot-manager-urls.json');
  try {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      WORKER_BOT_COUNT: '2',
      WORKER_ID_1: '01',
      WORKER_ID_2: '02',
      MANAGER_URL_CACHE_FILE: cacheFile
    });
    assert.strictEqual(cfg.managerUrl, DEFAULT_MANAGER_URL);
    assert.strictEqual(cfg.managerUrl, 'https://kbotmanager.onrender.com');
    assert.strictEqual(cfg.bots[0].workerId, '01');
    assert.strictEqual(cfg.bots[0].secret, '');
    assert.strictEqual(cfg.bots[1].workerId, '02');
    assert.strictEqual(cfg.bots[1].secret, '');
    console.log('1. Zero-MANAGER_URL + ID-only dual-slot loadConfig passed.');

    // 2. ManagerReporter learns multi-web URLs, omits x-worker-secret, and fails over on 503/suspended 404
    const requests = [];
    let web1Alive = true;
    const mockFetch = async (url, opts) => {
      requests.push({ url, headers: opts?.headers || {} });
      if (url.startsWith('https://web1.onrender.com')) {
        if (web1Alive) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name) => (String(name).toLowerCase() === 'x-manager-urls'
                ? 'https://web1.onrender.com,https://web2.onrender.com'
                : null)
            },
            json: async () => ({
              ok: true,
              settingsRevision: 1,
              managerUrls: ['https://web1.onrender.com', 'https://web2.onrender.com'],
              state: 'offline',
              settings: {}
            })
          };
        }
        // Suspended Render free app returns HTTP 503 or HTML 404
        return {
          ok: false,
          status: 503,
          headers: { get: () => null },
          json: async () => ({}),
          body: { cancel: async () => {} }
        };
      }
      if (url.startsWith('https://web2.onrender.com')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'https://web2.onrender.com,https://web1.onrender.com' },
          json: async () => ({ ok: true, settingsRevision: 2 })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const reporter = new ManagerReporter({
      baseUrl: 'https://web1.onrender.com',
      workerId: '01',
      secret: '',
      fetchImpl: mockFetch,
      logger: silentLogger
    });
    reporter.urlPool.cacheFilePath = cacheFile;

    await reporter.bootstrap();
    assert.strictEqual(requests[0].headers['x-worker-secret'], undefined, 'ID-only bootstrap must omit x-worker-secret');
    assert.strictEqual(requests[0].headers['x-manager-bot-id'], '01');
    assert.ok(reporter.getManagerUrls().includes('https://web2.onrender.com'), 'Must learn web2 URL from bootstrap');
    assert.ok(fs.existsSync(cacheFile), 'Must persist learned Manager URLs to cache file');

    // Simulate web1 hitting Render free-tier suspension -> heartbeat must fail over to web2 cleanly
    web1Alive = false;
    const hbRes = await reporter.sendHeartbeat({ state: 'idle', connected: false, workerId: '01' });
    assert.strictEqual(hbRes.ok, true);
    assert.strictEqual(reporter.baseUrl, 'https://web2.onrender.com', 'Active URL must switch to healthy web2');

    // SSRF / URL-pool poisoning defense: reject private/loopback/metadata targets, allow valid public HTTPS
    const learnedSsrf = reporter.learnManagerUrls('https://169.254.169.254,https://10.0.0.1,http://127.0.0.1:9999,https://web3.onrender.com');
    assert.strictEqual(learnedSsrf, true);
    const urlsAfterSsrf = reporter.getManagerUrls();
    assert.ok(!urlsAfterSsrf.some((u) => u.includes('169.254.169.254') || u.includes('10.0.0.1') || u.includes('127.0.0.1')), 'Must reject private/loopback/metadata URLs');
    assert.ok(urlsAfterSsrf.includes('https://web3.onrender.com'), 'Must learn valid public HTTPS URL');
    console.log('2. ManagerReporter multi-web learning, persistence, SSRF filter, and automatic failover passed.');

    // 3. WispbytePoller shares urlPool and fails over on HTML 404 from suspended Render web1 -> web2
    let pollerCalls = [];
    const pollerFetch = async (url, opts) => {
      pollerCalls.push({ url, headers: opts?.headers || {} });
      if (url.startsWith('https://web1.onrender.com')) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          json: async () => { throw new Error('HTML page'); },
          body: { cancel: async () => {} }
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'https://web2.onrender.com' },
        json: async () => ({ ok: true, command: null, settingsRevision: 3 })
      };
    };

    const poller = new WispbytePoller({
      config: {
        workerId: '01',
        secret: '',
        managerUrl: 'https://web1.onrender.com',
        managerUrls: ['https://web1.onrender.com', 'https://web2.onrender.com'],
        managerUrlCacheFile: cacheFile
      },
      runtime: { status: () => ({ state: 'idle' }) },
      reporter: null,
      logger: silentLogger,
      fetchImpl: pollerFetch
    });
    const pollRes = await poller.request('/api/v1/workers/01/poll', { waitMs: 100 });
    assert.strictEqual(pollRes.ok, true);
    assert.strictEqual(pollerCalls.length, 2, 'Must fail over from web1 404 HTML to web2');
    assert.strictEqual(pollerCalls[1].headers['x-worker-secret'], undefined);
    assert.strictEqual(pollerCalls[1].headers['x-manager-bot-id'], '01');
    assert.strictEqual(poller.urlPool.currentUrl(), 'https://web2.onrender.com');
    console.log('3. WispbytePoller suspended-web 404 failover & ID-only headers passed.');

    // 4. Worker HTTP server ID-only command route (when secret === '')
    let executedCmd = null;
    const learnedViaCmd = [];
    const mockFleet = {
      stopping: false,
      state: 'RUNNING',
      health: () => ({ ok: true }),
      list: () => [{
        config: { workerId: '01', secret: '' },
        runtime: { status: () => ({ state: 'idle' }), execute: async () => ({ ok: true }) },
        reporter: { learnManagerUrls: (u) => learnedViaCmd.push(u) }
      }],
      get: (id) => (id === '01' ? {
        config: { workerId: '01', secret: '' },
        runtime: {
          status: () => ({ state: 'idle', online: false }),
          execute: async (action, payload) => {
            executedCmd = { action, payload };
            return { ok: true, action };
          }
        },
        reporter: { learnManagerUrls: (u) => learnedViaCmd.push(u) }
      } : null)
    };
    const app = createApp({ fleet: mockFleet, config: cfg, logger: silentLogger });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;

      // Missing headers rejected with 401
      const noHeaderRes = await fetch(`${base}/api/v1/bots/01/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'status' })
      });
      assert.strictEqual(noHeaderRes.status, 401);

      // ID-only request succeeds and forwards x-manager-urls
      const idOnlyRes = await fetch(`${base}/api/v1/bots/01/command`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-manager-bot-id': '01',
          'x-manager-urls': 'https://web1.onrender.com,https://web2.onrender.com'
        },
        body: JSON.stringify({ action: 'status', payload: {} })
      });
      assert.strictEqual(idOnlyRes.status, 200);
      assert.strictEqual(executedCmd?.action, 'status');
      assert.strictEqual(learnedViaCmd[0], 'https://web1.onrender.com,https://web2.onrender.com');
      console.log('4. Worker HTTP ID-only command route + x-manager-urls sync passed.');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    // 5. WorkerFleet propagates managerUrlCacheFile cleanly to reporter & poller without touching %TEMP%\kbot-manager-urls.json
    const fleet = new WorkerFleet(cfg, silentLogger, { fetchImpl: mockFetch });
    try {
      const inst = fleet.get('01');
      const inst2 = fleet.get('02');
      assert.ok(inst, 'WorkerFleet must register slot 01');
      assert.ok(inst2, 'WorkerFleet must register slot 02');
      assert.strictEqual(inst.reporter.urlPool.cacheFilePath, cacheFile);
      assert.strictEqual(inst.poller.urlPool.cacheFilePath, cacheFile);
      assert.strictEqual(inst.reporter.urlPool, inst2.reporter.urlPool, 'Dual slots in one Worker must share ManagerUrlPool');
      inst.reporter.baseUrl = 'https://web2.onrender.com';
      assert.strictEqual(inst.reporter.urlPool.cacheFilePath, cacheFile);
      assert.strictEqual(inst2.poller.urlPool.currentUrl(), 'https://web2.onrender.com');
      console.log('5. WorkerFleet shared ManagerUrlPool & cacheFile propagation passed.');
    } finally {
      await fleet.stop();
    }

    // 6. Dual-slot quarantine: when slot 01 detects web1 dead, slot 02 routes directly to web2 without hitting web1; cooldown still allows fallback if web2 fails
    const dualHits = [];
    let dualWeb1Down = true;
    let dualWeb2Down = false;
    const dualFetch = async (url) => {
      dualHits.push(url);
      if (url.startsWith('https://web1.onrender.com')) {
        if (dualWeb1Down) {
          return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), body: { cancel: async () => {} } };
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, settings: {}, credentials: { username: 'B1', password: '' } }) };
      }
      if (url.startsWith('https://web2.onrender.com')) {
        if (dualWeb2Down) {
          return { ok: false, status: 502, headers: { get: () => null }, json: async () => ({}), body: { cancel: async () => {} } };
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, settings: {}, credentials: { username: 'B2', password: '' } }) };
      }
      throw new Error(`Unexpected dual URL: ${url}`);
    };
    const dualCfg = loadConfig({
      NODE_ENV: 'production',
      MANAGER_URL: 'https://web1.onrender.com',
      MANAGER_URLS: 'https://web1.onrender.com,https://web2.onrender.com',
      WORKER_BOT_COUNT: '2',
      WORKER_ID_1: '01',
      WORKER_ID_2: '02',
      MANAGER_URL_CACHE_FILE: cacheFile
    });
    const dualFleet = new WorkerFleet(dualCfg, silentLogger, { fetchImpl: dualFetch });
    try {
      await dualFleet.get('01').reporter.bootstrap();
      assert.strictEqual(dualHits.length, 2, 'Slot 01 must fail over from dead web1 to web2');
      await dualFleet.get('02').reporter.bootstrap();
      assert.strictEqual(dualHits.length, 3, 'Slot 02 must go straight to healthy web2 (0 wasted calls to quarantined web1)');
      assert.ok(dualHits[2].startsWith('https://web2.onrender.com'));

      // Now web2 breaks while web1 comes back online -> pool still falls back to cooled-down web1!
      dualWeb1Down = false;
      dualWeb2Down = true;
      await dualFleet.get('02').reporter.sendHeartbeat({ state: 'idle', connected: false, workerId: '02' });
      assert.ok(dualFleet.sharedUrlPool.currentUrl() === 'https://web1.onrender.com', 'Cooldown fallback must recover onto web1 when web2 goes down');
      console.log('6. Dual-slot URL quarantine & cooldown recovery fallback passed.');
    } finally {
      await dualFleet.stop();
    }

    // 7. Generic/HTML 404 (cloud proxy outage) must NEVER count as worker auth revocation or stop bot
    let generic404Poller;
    let generic404StopCalls = 0;
    let generic404Calls = 0;
    generic404Poller = new WispbytePoller({
      config: {
        workerId: '01',
        secret: '',
        managerUrl: 'https://web1.onrender.com',
        managerUrls: ['https://web1.onrender.com', 'https://web2.onrender.com'],
        managerUrlCacheFile: cacheFile
      },
      runtime: {
        status: () => ({ state: 'afk' }),
        execute: async (action) => {
          if (action === 'stop') generic404StopCalls += 1;
          return { ok: true };
        }
      },
      reporter: null,
      logger: silentLogger,
      authFailureThreshold: 1,
      fetchImpl: async () => {
        generic404Calls += 1;
        setImmediate(() => { void generic404Poller.stop(); });
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          json: async () => { throw new Error('<!DOCTYPE html>404'); },
          body: { cancel: async () => {} }
        };
      }
    });
    await generic404Poller.start();
    assert.ok(generic404Calls >= 2);
    assert.strictEqual(generic404Poller.consecutiveAuthFailures, 0, 'HTML/proxy 404 must not increment consecutiveAuthFailures');
    assert.strictEqual(generic404StopCalls, 0, 'HTML/proxy 404 must never stop active AFK bot');
    console.log('7. Proxy/HTML 404 non-destructive handling passed.');

    // 8. Real local HTTP servers + workerFetch keep-alive socket reuse + gzip decompression + x-manager-urls-sig + failover
    const zlib = require('node:zlib');
    const seenSocketsWeb1 = new Set();
    const seenHeaderSigsWeb1 = [];
    let web1FailMode = false;
    const srv1 = http.createServer((req, res) => {
      if (web1FailMode) {
        res.statusCode = 503;
        res.end('');
        return;
      }
      seenSocketsWeb1.add(req.socket);
      seenHeaderSigsWeb1.push(req.headers['x-manager-urls-sig'] || '');
      const payload = JSON.stringify({ ok: true, command: null, settingsRevision: 7, pad: 'x'.repeat(1500) });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Encoding', 'gzip');
      res.end(zlib.gzipSync(Buffer.from(payload)));
    });
    const srv2 = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, command: null, settingsRevision: 8 }));
    });
    await new Promise((r) => srv1.listen(0, '127.0.0.1', r));
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    try {
      const url1 = `http://127.0.0.1:${srv1.address().port}`;
      const url2 = `http://127.0.0.1:${srv2.address().port}`;
      const expectedSig = computeUrlsSignature([url1, url2]);

      const realPoller = new WispbytePoller({
        config: {
          workerId: '01',
          secret: '',
          managerUrl: url1,
          managerUrls: [url1, url2],
          managerUrlCacheFile: cacheFile
        },
        runtime: { status: () => ({ state: 'idle' }) },
        reporter: null,
        logger: silentLogger,
        fetchImpl: workerFetch
      });

      const r1 = await realPoller.request('/api/v1/workers/01/poll', { waitMs: 100 });
      const r2 = await realPoller.request('/api/v1/workers/01/poll', { waitMs: 100 });
      assert.strictEqual(r1.settingsRevision, 7);
      assert.strictEqual(r2.settingsRevision, 7);
      assert.strictEqual(seenSocketsWeb1.size, 1, 'workerFetch must reuse the same persistent keep-alive TCP socket across polls');
      assert.strictEqual(seenHeaderSigsWeb1[0], expectedSig, 'workerFetch must deliver x-manager-urls-sig header');

      web1FailMode = true;
      const r3 = await realPoller.request('/api/v1/workers/01/poll', { waitMs: 100 });
      assert.strictEqual(r3.settingsRevision, 8);
      assert.strictEqual(realPoller.urlPool.currentUrl(), url2);
      console.log('8. workerFetch keep-alive socket reuse, gzip decode, x-manager-urls-sig, and live failover passed.');
    } finally {
      closeWorkerHttpAgents();
      srv1.closeAllConnections?.();
      srv2.closeAllConnections?.();
      await Promise.all([
        new Promise((r) => srv1.close(r)),
        new Promise((r) => srv2.close(r))
      ]);
    }

    console.log('✅ ALL MULTI-MANAGER & ID-ONLY WORKER TESTS PASSED!');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ MULTI-MANAGER & ID-ONLY WORKER TEST FAILED:', err);
  process.exit(1);
});
