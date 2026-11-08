'use strict';

require('dotenv').config();
const http = require('node:http');
const { loadConfig } = require('./config/env');
const logger = require('./utils/logger');
const WorkerFleet = require('./services/worker-fleet');
const { createApp } = require('./http/app');

async function main() {
  const config = loadConfig();
  const fleet = new WorkerFleet(config, logger);
  const app = createApp({ fleet, config, logger });
  const server = http.createServer(app);
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  logger.info('worker_http_started', {
    botCount: config.botCount, transport: config.transport, platform: config.platform,
    port: config.port, portSource: config.portSource
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('worker_shutdown', { signal, botCount: config.botCount });
    await fleet.stop();
    await new Promise((resolve) => server.close(resolve));
    process.exitCode = 0;
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  try { await fleet.start(); }
  catch (error) {
    await fleet.stop();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}

main().catch((error) => {
  logger.error('worker_startup_failed', { error: error.message });
  process.exitCode = 1;
});

