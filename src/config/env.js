'use strict';

const { isIP } = require('node:net');
const { parseSocksProxy } = require('./proxy');
const { detectHostRuntime } = require('./host-runtime');

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function required(value, key) {
  const text = String(value || '').trim();
  if (!text || /replace-with|example|changeme/i.test(text)) throw new Error(`${key} must be configured.`);
  return text;
}

function readSlot(env, slot, common) {
  const suffix = `_${slot}`;
  const slotValue = (name, legacyName = name) => env[`${name}${suffix}`] ?? (slot === 1 ? env[legacyName] : undefined);
  const workerId = required(slotValue('WORKER_ID'), `WORKER_ID${suffix}`);
  const secret = required(slotValue('WORKER_SECRET'), `WORKER_SECRET${suffix}`);
  // Minecraft credentials are managed by Discord Manager and fetched through
  // the worker-authenticated HTTPS bootstrap endpoint, never from host env.
  const username = '';
  const password = '';
  const proxyUrl = String(slotValue('MC_PROXY_URL') || common.proxyUrl || '').trim();
  const authType = String(slotValue('MC_AUTH_TYPE') || common.authType).trim().toLowerCase();
  const afkMode = 'still';
  const viewDistance = String(slotValue('MC_VIEW_DISTANCE') || common.viewDistance).trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(workerId)) throw new Error(`WORKER_ID${suffix} must be 2–40 lowercase letters, numbers, underscores, or hyphens.`);
  if (secret.length < 32 || /replace-with|example|changeme/i.test(secret)) throw new Error(`WORKER_SECRET${suffix} must be a unique random secret of at least 32 characters.`);
  if (!['offline', 'microsoft'].includes(authType)) throw new Error(`MC_AUTH_TYPE${suffix} must be offline or microsoft.`);
  if (!['tiny', 'short', 'normal', 'far'].includes(viewDistance)) throw new Error(`MC_VIEW_DISTANCE${suffix} must be tiny, short, normal, or far.`);
  const proxy = parseSocksProxy(proxyUrl, `MC_PROXY_URL${suffix}`);

  return Object.freeze({
    ...common,
    workerId,
    secret,
    mc: Object.freeze({ ...common.mc, username, password, authType, viewDistance, proxy }),
    afk: Object.freeze({ ...common.afk, mode: afkMode })
  });
}

function loadConfig(env = process.env) {
  const managerUrl = required(env.MANAGER_URL, 'MANAGER_URL').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(managerUrl)) throw new Error('MANAGER_URL must use HTTPS.');

  const hosts = String(env.MC_SERVER_HOSTS || 'sgp.kingmc.vn,kingmc.vn')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  const validHost = (host) => isIP(host) !== 0 || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host);
  if (!hosts.length || hosts.some((host) => !validHost(host))) {
    throw new Error('MC_SERVER_HOSTS must contain valid hostnames or IPv4 addresses.');
  }

  const hostRuntime = detectHostRuntime(env);
  const transport = String(env.WORKER_TRANSPORT || hostRuntime.transport).trim().toLowerCase();
  if (!['render-http', 'wispbyte-poll'].includes(transport)) throw new Error('WORKER_TRANSPORT must be render-http or wispbyte-poll.');
  const authType = String(env.MC_AUTH_TYPE || 'offline').trim().toLowerCase();
  if (!['offline', 'microsoft'].includes(authType)) throw new Error('MC_AUTH_TYPE must be offline or microsoft.');
  const afkMode = 'still';
  const viewDistance = String(env.MC_VIEW_DISTANCE || 'short').trim().toLowerCase();
  if (!['tiny', 'short', 'normal', 'far'].includes(viewDistance)) throw new Error('MC_VIEW_DISTANCE must be tiny, short, normal, or far.');

  const authEnabled = bool(env.MC_AUTH_ENABLED, true);
  const actionMin = positiveInt(env.AFK_ACTION_MIN_MS, 180000, 10000, 86400000);
  const actionMax = positiveInt(env.AFK_ACTION_MAX_MS, 360000, actionMin, 86400000);
  const common = {
    nodeEnv: env.NODE_ENV || 'development',
    transport,
    managerUrl,
    authType,
    afkMode,
    viewDistance,
    port: hostRuntime.port,
    host: env.HOST || '0.0.0.0',
    platform: hostRuntime.platform,
    portSource: hostRuntime.portSource,
    mc: Object.freeze({
      hosts: Object.freeze(hosts),
      port: positiveInt(env.MC_SERVER_PORT, 25565, 1, 65535),
      version: env.MC_SERVER_VERSION || '1.20.1',
      viewDistance
    }),
    proxyUrl: String(env.MC_PROXY_URL || '').trim(),
    afk: Object.freeze({ minMs: actionMin, maxMs: actionMax }),
    authEnabled,
    autoStart: bool(env.AUTO_START, true),
    autoReconnect: bool(env.AUTO_RECONNECT, true),
    joinCommand: String(env.JOIN_COMMAND || '').trim(),
    joinDelayMs: positiveInt(env.JOIN_DELAY_MS, 4000, 0, 120000),
    maintenanceWaitMs: 600000,
    connectTimeoutMs: positiveInt(env.CONNECT_TIMEOUT_MS, 30000, 5000, 180000),
    reconnectBaseMs: positiveInt(env.RECONNECT_BASE_MS, 5000, 1000, 300000),
    reconnectMaxMs: positiveInt(env.RECONNECT_MAX_MS, 120000, 5000, 3600000),
    rssWarnMb: positiveInt(env.WORKER_RSS_WARN_MB, 440, 128, 16384),
    logLevel: env.LOG_LEVEL || 'info',
    wispbyte: Object.freeze({
      cookie: String(env.WISPBYTE_COOKIE || '').trim(),
      panelUrl: String(env.WISPBYTE_PANEL_URL || 'https://wispbyte.com/client').trim(),
      intervalMs: positiveInt(env.WISPBYTE_KEEPALIVE_INTERVAL_MS, 86400000, 60000, 604800000)
    })
  };
  const rawBotCount = env.WORKER_BOT_COUNT === undefined || env.WORKER_BOT_COUNT === ''
    ? (env.WORKER_ID_2 ? 2 : 1) : Number(env.WORKER_BOT_COUNT);
  if (!Number.isInteger(rawBotCount) || rawBotCount < 1 || rawBotCount > 2) throw new Error('WORKER_BOT_COUNT must be 1 or 2.');
  const botCount = rawBotCount;
  const bots = Array.from({ length: botCount }, (_, index) => readSlot(env, index + 1, common));
  if (new Set(bots.map((bot) => bot.workerId)).size !== bots.length) throw new Error('Each bot slot must use a different WORKER_ID.');
  if (new Set(bots.map((bot) => bot.secret)).size !== bots.length) throw new Error('Each bot slot must use a different WORKER_SECRET.');

  return Object.freeze({ ...common, botCount, bots: Object.freeze(bots) });
}

module.exports = { loadConfig, positiveInt, bool };
