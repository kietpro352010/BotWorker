'use strict';

const { isIP } = require('node:net');

function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (['localhost', 'localhost.localdomain'].includes(host) || /\.(?:localhost|local|internal|lan)$/.test(host)) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(host) === 6) {
    return host === '::' || host === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb|ff)/.test(host)
      || /^::ffff:(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host);
  }
  return false;
}

function parseSocksProxy(value, label = 'MC_PROXY_URL') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} must be a valid SOCKS5 URL.`); }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'socks5:' || !parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535
      || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(`${label} must use socks5://host:port with optional username and password.`);
  }
  if (isLocalOrPrivateHost(parsed.hostname)) throw new Error(`${label} cannot target a local or private network address.`);
  const username = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  if (username.length > 255 || password.length > 255 || /[\u0000-\u001f\u007f]/.test(username + password)) {
    throw new Error(`${label} credentials are invalid.`);
  }
  return Object.freeze({ host: parsed.hostname.replace(/^\[|\]$/g, ''), port, username, password });
}

module.exports = { parseSocksProxy, isLocalOrPrivateHost };
