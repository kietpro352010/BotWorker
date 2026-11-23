'use strict';

const { isIP } = require('node:net');
const dns = require('node:dns').promises;

function expandIpv6Groups(rawIp) {
  let ip = String(rawIp || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx);
  if (!ip.includes(':')) return null;

  // Handle embedded IPv4 tail (e.g., ::ffff:127.0.0.1, ::127.0.0.1, 64:ff9b::10.0.0.1)
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    const octets = tail.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  if (parts.length === 1 && left.length !== 8) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const full = parts.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  if (full.length !== 8) return null;
  const groups = full.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return groups;
}

function isPrivateIpv4Octets(a, b) {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function isPrivateIpv6Address(ip) {
  const groups = expandIpv6Groups(ip);
  if (!groups) return true; // Fail closed on unparseable IPv6
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const allZeroPrefix5 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // :: (unspecified) and ::1 (loopback)
  if (allZeroPrefix5 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) and IPv4-translated (::ffff:0:0:0/96)
  if ((allZeroPrefix5 && (g5 === 0xffff || g5 === 0)) || (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0)) {
    const a = (g6 >> 8) & 0xff;
    const b = g6 & 0xff;
    return isPrivateIpv4Octets(a, b);
  }
  // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4Octets((g6 >> 8) & 0xff, g6 & 0xff);
  }
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) return true;
  // 6to4 (2002::/16) embedding private IPv4 in g1:g2
  if (g0 === 0x2002) {
    return isPrivateIpv4Octets((g1 >> 8) & 0xff, g1 & 0xff);
  }
  // Teredo (2001:0000::/32), Discard (100::/64), Benchmarking (2001:2::/48), Documentation (2001:db8::/32)
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8 || (g1 === 0x0002 && g2 === 0))) return true;
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // ULA (fc00::/7), Link-local (fe80::/10), Deprecated site-local (fec0::/10), Multicast (ff00::/8)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!host || ['localhost', 'localhost.localdomain', 'metadata.google.internal', 'instance-data'].includes(host)
      || /\.(?:localhost|local|internal|lan)$/.test(host)) return true;

  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return isPrivateIpv4Octets(a, b);
  }
  if (isIP(host) === 6 || host.includes(':')) {
    return isPrivateIpv6Address(host);
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
  const ipv4Record = records.find((rec) => rec.family === 4 || isIP(rec.address) === 4);
  return (ipv4Record || records[0]).address;
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

    const emitFailure = (err) => {
      queueMicrotask(() => {
        try { client.emit('error', err); } catch (_) {}
        if (!client.ended) {
          client.ended = true;
          try { client.emit('end', err?.message || 'socks_proxy_error'); } catch (_) {}
        }
      });
    };

    timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        cleanup();
        const err = new Error(`SOCKS5 proxy connection timed out after ${safeTimeoutMs}ms (${proxy.host}:${proxy.port})`);
        err.code = 'ETIMEDOUT';
        emitFailure(err);
      }
    }, safeTimeoutMs);
    timer.unref?.();

    void (async () => {
      try {
        const resolvedIp = await assertPublicProxyHost(proxy.host, 'SOCKS5 proxy');
        if (finished || client.ended) return;
        const proxyOptions = {
          proxy: {
            host: resolvedIp,
            port: proxy.port,
            type: 5,
            ...((proxy.username || proxy.password) ? { userId: proxy.username || '', password: proxy.password || '' } : {})
          },
          command: 'connect',
          destination: { host, port },
          timeout: safeTimeoutMs
        };

        SocksClient.createConnection(proxyOptions, (error, info) => {
          if (finished || client.ended) {
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
            emitFailure(error);
            return;
          }

          try {
            info.socket?.setNoDelay?.(true);
            info.socket?.setKeepAlive?.(true, 15000);
          } catch (_) {}
          client.setSocket(info.socket);
          client.emit('connect');
        });
      } catch (err) {
        if (finished || client.ended) return;
        finished = true;
        cleanup();
        logger?.warn?.('socks_proxy_rejected', { host: proxy.host, error: err?.message });
        emitFailure(err);
      }
    })();
  };
}

module.exports = { parseSocksProxy, isLocalOrPrivateHost, assertPublicProxyHost, createSocksConnector };
