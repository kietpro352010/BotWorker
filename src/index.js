'use strict';

require('dotenv').config();

// Kích hoạt V8 Garbage Collection nội bộ (Trụ cột 1.1)
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
const { loadConfig } = require('./config/env');
const { listenHttpServer } = require('./config/host-runtime');
const logger = require('./utils/logger');
const WorkerFleet = require('./services/worker-fleet');
const { createApp } = require('./http/app');

async function main() {
  const config = loadConfig();
  const fleet = new WorkerFleet(config, logger);
  const app = createApp({ fleet, config, logger });
  const server = http.createServer(app);

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

  // Adaptive Memory Sweeper (Trụ cột 1.1)
  const memorySweepInterval = setInterval(() => {
    const memory = process.memoryUsage();
    const rssMb = Math.round(memory.rss / (1024 * 1024));
    const heapUsedMb = Math.round(memory.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(memory.heapTotal / (1024 * 1024));

    // Ngưỡng cảnh báo bộ nhớ trên Worker (250MB RSS hoặc >75% heap)
    if (rssMb > 250 || heapUsedMb > 0.75 * heapTotalMb) {
      const collected = runGarbageCollection();
      logger.info('worker_memory_sweep', { rssMb, heapUsedMb, heapTotalMb, collected });
    }
  }, 30000);
  memorySweepInterval.unref();

  let shuttingDown = false;
  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (exitCode !== 0) {
      setTimeout(() => process.exit(exitCode), 2000).unref();
    } else {
      setTimeout(() => process.exit(0), 2000).unref();
    }
    clearInterval(memorySweepInterval);
    logger.info('worker_shutdown', { signal, botCount: config.botCount, exitCode });
    try {
      await fleet.stop();
    } catch (err) {
      logger.error('worker_shutdown_fleet_stop_error', { error: err?.message || String(err) });
      exitCode = 1;
    } finally {
      try {
        await new Promise((resolve) => server.close(resolve));
      } catch (err) {
        logger.error('worker_shutdown_server_close_error', { error: err?.message || String(err) });
        exitCode = 1;
      }
    }
    process.exitCode = exitCode;
    process.exit(exitCode);
  };

  process.once('SIGTERM', () => { shutdown('SIGTERM', 0).catch(() => process.exit(1)); });
  process.once('SIGINT', () => { shutdown('SIGINT', 0).catch(() => process.exit(1)); });
  process.on('uncaughtException', (error) => {
    logger.error('worker_uncaught_exception', { error: error?.message || String(error), stack: error?.stack });
    shutdown('uncaughtException', 1).catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('worker_unhandled_rejection', { error: reason?.message || String(reason), stack: reason?.stack });
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
