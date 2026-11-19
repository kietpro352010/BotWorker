'use strict';

const { isIP } = require('node:net');
const dns = require('node:dns').promises;

function decodeIpv4Mapped(host) {
  const match = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (match) return match[1];
  const hexMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMatch) {
    const p1 = parseInt(hexMatch[1], 16);
    const p2 = parseInt(hexMatch[2], 16);
    return `${(p1 >> 8) & 0xff}.${p1 & 0xff}.${(p2 >> 8) & 0xff}.${p2 & 0xff}`;
  }
  return null;
}

function isPrivateIpv4Octets(a, b) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (['localhost', 'localhost.localdomain', 'metadata.google.internal', 'instance-data'].includes(host)
      || /\.(?:localhost|local|internal|lan)$/.test(host)) return true;

  const mappedIpv4 = decodeIpv4Mapped(host);
  if (mappedIpv4 && isIP(mappedIpv4) === 4) {
    const [a, b] = mappedIpv4.split('.').map(Number);
    return isPrivateIpv4Octets(a, b);
  }

  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return isPrivateIpv4Octets(a, b);
  }
  if (isIP(host) === 6) {
    return host === '::' || host === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb|ff)/.test(host);
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
  let username = '';
  let password = '';
  try {
    username = decodeURIComponent(parsed.username || '');
    password = decodeURIComponent(parsed.password || '');
  } catch {
    throw new Error(`${label} credentials contain invalid percent-encoding.`);
  }
  if (username.length > 255 || password.length > 255 || /[\u0000-\u001f\u007f]/.test(username + password)) {
    throw new Error(`${label} credentials are invalid.`);
  }
  return Object.freeze({ host: parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, ''), port, username, password });
}

async function assertPublicProxyHost(host, label = 'MC_PROXY_URL') {
  const cleanHost = String(host || '').replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!cleanHost || isLocalOrPrivateHost(cleanHost)) {
    throw new Error(`${label} cannot target a local or private network address.`);
  }
  if (isIP(cleanHost)) return cleanHost;
  let records;
  try {
    records = await dns.lookup(cleanHost, { all: true, verbatim: true });
  } catch (err) {
    const wrapped = new Error(`${label} hostname resolution failed: ${err?.code || err?.message || 'dns_error'}`);
    wrapped.code = err?.code || 'ENOTFOUND';
    throw wrapped;
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${label} hostname resolved to no addresses.`);
  }
  for (const rec of records) {
    if (!rec?.address || isLocalOrPrivateHost(rec.address)) {
      throw new Error(`${label} resolved to a local or private network address.`);
    }
  }
  return records[0].address;
}

function createSocksConnector(proxy, host, port, { timeoutMs = 10000, logger } = {}) {
  const { SocksClient } = require('socks');
  const safeTimeoutMs = Math.max(1000, Number(timeoutMs) || 10000);

  return (client) => {
    let finished = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      client.removeListener('end', onClientClosed);
      client.removeListener('close', onClientClosed);
    };

    const onClientClosed = () => {
      if (!finished) {
        finished = true;
        cleanup();
      }
    };
    client.once('end', onClientClosed);
    client.once('close', onClientClosed);

    timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        cleanup();
        const err = new Error(`SOCKS5 proxy connection timed out after ${safeTimeoutMs}ms (${proxy.host}:${proxy.port})`);
        err.code = 'ETIMEDOUT';
        queueMicrotask(() => client.emit('error', err));
      }
    }, safeTimeoutMs);
    timer.unref?.();

    void (async () => {
      try {
        const resolvedIp = await assertPublicProxyHost(proxy.host, 'SOCKS5 proxy');
        if (finished) return;
        const proxyOptions = {
          proxy: {
            host: resolvedIp,
            port: proxy.port,
            type: 5,
            ...(proxy.username ? { userId: proxy.username, password: proxy.password } : {})
          },
          command: 'connect',
          destination: { host, port },
          timeout: safeTimeoutMs
        };

        SocksClient.createConnection(proxyOptions, (error, info) => {
          if (finished) {
            if (info?.socket) {
              try { info.socket.destroy(); } catch (_) {}
            }
            return;
          }
          finished = true;
          cleanup();

          if (error) {
            if (info?.socket) {
              try { info.socket.destroy(); } catch (_) {}
            }
            queueMicrotask(() => client.emit('error', error));
            return;
          }

          client.setSocket(info.socket);
          client.emit('connect');
        });
      } catch (err) {
        if (finished) return;
        finished = true;
        cleanup();
        logger?.warn?.('socks_proxy_rejected', { host: proxy.host, error: err?.message });
        queueMicrotask(() => client.emit('error', err));
      }
    })();
  };
}

module.exports = { parseSocksProxy, isLocalOrPrivateHost, assertPublicProxyHost, createSocksConnector };
