'use strict';

function validPort(value) {
  const text = String(value || '').trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function detectHostRuntime(env = process.env) {
  const render = String(env.RENDER || '').toLowerCase() === 'true'
    || Boolean(env.RENDER_SERVICE_ID || env.RENDER_INSTANCE_ID || env.RENDER_EXTERNAL_URL || env.RENDER_EXTERNAL_HOSTNAME);
  const wispbyte = Boolean(env.WISPBYTE || env.WISP || env.WISPBAY || env.DEPLEXO || env.PTERODACTYL || env.STARTUP
    || env.P_SERVER_UUID || env.P_SERVER_ALLOCATION_LIMIT || env.P_SERVER_PORT || env.SERVER_PORT || env.ALLOCATION_PORT);
  const platform = render ? 'render' : (wispbyte ? 'wispbyte' : 'generic-node');
  let port = null;
  let portSource = 'default';
  for (const key of ['SERVER_PORT', 'P_SERVER_PORT', 'ALLOCATION_PORT', 'PORT', 'APP_PORT', 'WEB_PORT']) {
    port = validPort(env[key]);
    if (port) { portSource = key; break; }
  }
  if (!port && render) { port = 10000; portSource = 'render-default'; }
  if (!port) { port = 10000; portSource = 'application-default'; }
  return Object.freeze({ platform, transport: render ? 'render-http' : 'wispbyte-poll', port, portSource });
}

async function listenHttpServer(server, { host = '0.0.0.0', port, maxRetries = 10, retryDelayMs = 1000, logger = console } = {}) {
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 40000;

  let currentPort = port;
  let attempts = 0;

  while (attempts < maxRetries) {
    attempts++;
    try {
      await new Promise((resolve, reject) => {
        const errorHandler = (err) => {
          server.removeListener('listening', successHandler);
          reject(err);
        };
        const successHandler = () => {
          server.removeListener('error', errorHandler);
          resolve();
        };
        server.once('error', errorHandler);
        server.once('listening', successHandler);
        server.listen(currentPort, host);
      });
      return { port: currentPort, host };
    } catch (err) {
      if (err.code === 'EADDRINUSE' && attempts < maxRetries) {
        logger.warn?.(`Port ${currentPort} in use, retrying in ${retryDelayMs}ms (attempt ${attempts}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { detectHostRuntime, validPort, listenHttpServer };
