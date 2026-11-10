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
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(memorySweepInterval);
    logger.info('worker_shutdown', { signal, botCount: config.botCount });
    await fleet.stop();
    await new Promise((resolve) => server.close(resolve));
    process.exitCode = 0;
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  try {
    await fleet.start();
  } catch (error) {
    await fleet.stop();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}

main().catch((error) => {
  logger.error('worker_startup_failed', { error: error.message });
  process.exitCode = 1;
});
