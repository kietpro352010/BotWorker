'use strict';

const { loadConfig, loadDotenvSafe } = require('./config/env');
loadDotenvSafe();

// Kích hoạt V8 Garbage Collection nội bộ (KHÔNG bật --optimize_for_size vì cờ này tắt TurboFan JIT inlining và gây bão GC tốn gấp 2-4 lần CPU)
const v8 = require('node:v8');
const vm = require('node:vm');
try {
  v8.setFlagsFromString('--expose_gc');
  if (typeof global.gc !== 'function') {
    global.gc = vm.runInNewContext('gc');
  }
} catch (_) {}

function runGarbageCollection() {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
      return true;
    } catch (_) {}
  }
  return false;
}

const http = require('node:http');
const { listenHttpServer } = require('./config/host-runtime');
const logger = require('./utils/logger');
const WorkerFleet = require('./services/worker-fleet');
const { createApp } = require('./http/app');
const { closeWorkerHttpAgents } = require('./transports/http-client');

async function main() {
  const config = loadConfig();
  const fleet = new WorkerFleet(config, logger);
  const app = createApp({ fleet, config, logger });
  const server = http.createServer(app);
  // Align Node HTTP keep-alive above upstream reverse-proxy idle timeout (60s) to prevent 502 races
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 35000;

  await listenHttpServer(server, {
    port: config.port,
    host: config.host || '0.0.0.0',
    logger
  });

  logger.info('worker_http_started', {
    botCount: config.botCount,
    transport: config.transport,
    platform: config.platform,
    port: config.port,
    portSource: config.portSource
  });

  // Adaptive Memory Sweeper (so sánh theo heap_size_limit V8, tránh GC Stop-The-World liên tục gây spike CPU trên container 400MB)
  let lastSweepGcAt = 0;
  const heapLimitMb = Math.max(192, Math.round((v8.getHeapStatistics()?.heap_size_limit || 0) / (1024 * 1024)) || 400);
  const rssThresholdMb = config.platform === 'wispbyte' ? 260 : 280;
  const heapThresholdMb = Math.max(128, Math.round(heapLimitMb * 0.72));
  const emergencyHeapMb = Math.round(heapLimitMb * 0.85);

  const memorySweepInterval = setInterval(() => {
    const memory = process.memoryUsage();
    const rssMb = Math.round(memory.rss / (1024 * 1024));
    const heapUsedMb = Math.round(memory.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(memory.heapTotal / (1024 * 1024));

    const now = Date.now();
    const overThreshold = rssMb >= rssThresholdMb || heapUsedMb >= heapThresholdMb;
    const emergency = rssMb >= 340 || heapUsedMb >= emergencyHeapMb;
    if (overThreshold && (now - lastSweepGcAt >= 5 * 60 * 1000 || emergency)) {
      lastSweepGcAt = now;
      fleet.pruneAllMemory?.();
      const collected = emergency ? runGarbageCollection() : false;
      const after = process.memoryUsage();
      const afterRssMb = Math.round(after.rss / (1024 * 1024));
      const afterHeapMb = Math.round(after.heapUsed / (1024 * 1024));
      const reclaimedRssMb = rssMb - afterRssMb;
      const reclaimedHeapMb = heapUsedMb - afterHeapMb;
      if (reclaimedRssMb >= 4 || reclaimedHeapMb >= 3 || afterRssMb >= 300) {
        logger.info('worker_memory_sweep', {
          rssMb: afterRssMb,
          heapUsedMb: afterHeapMb,
          heapTotalMb,
          heapLimitMb,
          reclaimedRssMb,
          reclaimedHeapMb,
          collected
        });
      } else {
        logger.debug?.('worker_memory_sweep_noop', {
          rssMb: afterRssMb,
          heapUsedMb: afterHeapMb,
          heapLimitMb,
          collected
        });
      }
    }
  }, 60000);
  memorySweepInterval.unref();

  let shuttingDown = false;
  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    let currentExitCode = exitCode;
    const forceExitTimer = setTimeout(() => process.exit(currentExitCode), 8000);
    forceExitTimer.unref?.();
    clearInterval(memorySweepInterval);
    logger.info('worker_shutdown', { signal, botCount: config.botCount, exitCode: currentExitCode });
    try {
      await fleet.stop();
    } catch (err) {
      logger.error('worker_shutdown_fleet_stop_error', { error: err?.message || String(err) });
      currentExitCode = 1;
    } finally {
      let graceCloseTimer = null;
      try {
        server.closeIdleConnections?.();
        const closePromise = new Promise((resolve) => server.close(resolve));
        graceCloseTimer = setTimeout(() => {
          server.closeAllConnections?.();
        }, 3000);
        graceCloseTimer.unref?.();
        await closePromise;
      } catch (err) {
        logger.error('worker_shutdown_server_close_error', { error: err?.message || String(err) });
        currentExitCode = 1;
      } finally {
        if (graceCloseTimer) clearTimeout(graceCloseTimer);
      }
      closeWorkerHttpAgents();
    }
    clearTimeout(forceExitTimer);
    process.exitCode = currentExitCode;
    process.exit(currentExitCode);
  };

  process.once('SIGTERM', () => { shutdown('SIGTERM', 0).catch(() => process.exit(1)); });
  process.once('SIGINT', () => { shutdown('SIGINT', 0).catch(() => process.exit(1)); });
  process.on('uncaughtException', (error) => {
    logger.error('worker_uncaught_exception', { error: error?.message || String(error), stack: error?.stack });
    shutdown('uncaughtException', 1).catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('worker_unhandled_rejection', { error: reason?.message || String(reason), stack: reason?.stack });
    shutdown('unhandledRejection', 1).catch(() => process.exit(1));
  });

  try {
    await fleet.start();
  } catch (error) {
    clearInterval(memorySweepInterval);
    try { await fleet.stop(); } catch (_) {}
    try { await new Promise((resolve) => server.close(resolve)); } catch (_) {}
    throw error;
  }
}

main().catch((error) => {
  logger.error('worker_startup_failed', { error: error?.message || String(error), stack: error?.stack });
  process.exitCode = 1;
  process.exit(1);
});
