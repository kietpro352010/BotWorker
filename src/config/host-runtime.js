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

module.exports = { detectHostRuntime, validPort };
