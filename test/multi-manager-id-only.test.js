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
      assert.ok(inst, 'WorkerFleet must register slot 01');
      assert.strictEqual(inst.reporter.urlPool.cacheFilePath, cacheFile);
      assert.strictEqual(inst.poller.urlPool.cacheFilePath, cacheFile);
      inst.reporter.baseUrl = 'https://web2.onrender.com';
      assert.strictEqual(inst.reporter.urlPool.cacheFilePath, cacheFile);
      console.log('5. WorkerFleet managerUrlCacheFile propagation passed.');
    } finally {
      await fleet.stop();
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
