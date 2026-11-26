'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MANAGER_URL = 'https://kbotmanager.onrender.com';
const MAX_MANAGER_URLS = 8;

function isPrivateOrInternalHost(hostname) {
  const bare = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!bare) return true;
  if (bare === 'localhost' || bare.endsWith('.local') || bare.endsWith('.localhost') || bare.endsWith('.internal')) {
    return true;
  }
  if (net.isIPv4(bare)) {
    const [b0, b1] = bare.split('.').map(Number);
    if (b0 === 0 || b0 === 10 || b0 === 127) return true;
    if (b0 === 169 && b1 === 254) return true;
    if (b0 === 192 && b1 === 168) return true;
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    return false;
  }
  if (net.isIPv6(bare)) {
    if (bare === '::1' || bare === '::' || bare === '0:0:0:0:0:0:0:1' || bare === '0:0:0:0:0:0:0:0') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(bare) || /^fe[89ab][0-9a-f]:/i.test(bare)) return true;
    const v4Match = bare.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4Match && isPrivateOrInternalHost(v4Match[1])) return true;
    return false;
  }
  if (!bare.includes('.')) return true;
  return false;
}

function getCacheFilePath(env = process.env) {
  const explicit = String(env?.MANAGER_URL_CACHE_FILE || '').trim();
  if (explicit) return explicit;
  if (env?.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) return null;
  return path.join(os.tmpdir(), 'kbot-manager-urls.json');
}

function normalizeManagerUrl(raw, { strictHttps = false, onlyPublicHttps = false, allowLoopbackHttp = true } = {}) {
  const text = String(raw || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const u = new URL(text);
    if (!u.hostname || u.username || u.password) return '';
    const hostLower = String(u.hostname || '').toLowerCase();
    const bareHost = hostLower.replace(/^\[|\]$/g, '');
    const isLoopback = bareHost === 'localhost' || bareHost === '127.0.0.1' || bareHost === '::1';
    const isHttps = u.protocol === 'https:';
    const isLocalHttp = u.protocol === 'http:' && isLoopback;
    let isAllowedProto = false;
    if (onlyPublicHttps) {
      isAllowedProto = isHttps && !isPrivateOrInternalHost(bareHost) && net.isIP(bareHost) === 0;
    } else if (strictHttps) {
      if (isLocalHttp) {
        isAllowedProto = allowLoopbackHttp === true;
      } else if (isHttps) {
        isAllowedProto = !isPrivateOrInternalHost(bareHost) || (isLoopback && allowLoopbackHttp === true);
      }
    } else {
      isAllowedProto = isHttps || u.protocol === 'http:';
    }
    if (!isAllowedProto) return '';
    return u.origin;
  } catch {
    return '';
  }
}

function mergeManagerUrls(existing = [], incoming = [], { max = MAX_MANAGER_URLS, strictHttps = false, onlyPublicHttps = false, allowLoopbackHttp = true } = {}) {
  const out = [];
  const push = (val) => {
    if (Array.isArray(val)) {
      for (const item of val) push(item);
      return;
    }
    if (typeof val === 'string' && val.includes(',')) {
      for (const part of val.split(',')) push(part);
      return;
    }
    const norm = normalizeManagerUrl(val, { strictHttps, onlyPublicHttps, allowLoopbackHttp });
    if (norm && !out.includes(norm)) out.push(norm);
  };
  push(existing);
  push(incoming);
  return out.slice(0, max);
}

function loadCachedManagerUrls(cacheFilePath = getCacheFilePath()) {
  if (!cacheFilePath) return [];
  try {
    if (!fs.existsSync(cacheFilePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.urls) ? parsed.urls : []);
    return mergeManagerUrls(list, [], { onlyPublicHttps: true });
  } catch {
    return [];
  }
}

function persistCachedManagerUrls(urls, cacheFilePath = getCacheFilePath()) {
  if (!cacheFilePath) return false;
  const normalized = mergeManagerUrls(urls, [], { onlyPublicHttps: true });
  if (!normalized.length) return false;
  try {
    const dir = path.dirname(cacheFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${cacheFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ urls: normalized, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(tmp, cacheFilePath);
    return true;
  } catch {
    return false;
  }
}

function shouldFailoverResponse(response, body) {
  const status = Number(response?.status || 0);
  if (!status) return true;
  if ([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(status)) return true;
  // Render suspended services return 404 (or HTML) without our JSON worker_not_found error.
  if (status === 404) {
    const errCode = String(body?.error || '').trim();
    if (!errCode || !['worker_not_found', 'worker_not_found_or_disabled', 'missing_worker_id'].includes(errCode)) {
      return true;
    }
  }
  return false;
}

class ManagerUrlPool {
  constructor({ baseUrl = '', managerUrls = null, cacheFilePath = undefined, defaultFallback = false } = {}) {
    this.cacheFilePath = cacheFilePath !== undefined ? cacheFilePath : getCacheFilePath();
    const initial = [];
    if (baseUrl) initial.push(baseUrl);
    if (Array.isArray(managerUrls) && managerUrls.length) initial.push(...managerUrls);
    if (defaultFallback || (!initial.length)) {
      initial.push(...loadCachedManagerUrls(this.cacheFilePath), DEFAULT_MANAGER_URL);
    }
    this.urls = mergeManagerUrls(initial);
    this.activeIndex = 0;
  }

  currentUrl() {
    if (!this.urls.length) return '';
    if (this.activeIndex >= this.urls.length) this.activeIndex = 0;
    return this.urls[this.activeIndex] || this.urls[0] || '';
  }

  getUrlsOrdered() {
    if (!this.urls.length) return [];
    const idx = Math.max(0, Math.min(this.activeIndex, this.urls.length - 1));
    return [this.urls[idx], ...this.urls.slice(0, idx), ...this.urls.slice(idx + 1)];
  }

  markHealthy(url) {
    const idx = this.urls.indexOf(url);
    if (idx >= 0) this.activeIndex = idx;
  }

  learn(rawUrls) {
    if (!rawUrls || (Array.isArray(rawUrls) && !rawUrls.length)) return false;
    const beforeKey = this.urls.join(',');
    const current = this.currentUrl();
    const hasLocalInitial = this.urls.some((u) => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(u));
    const merged = mergeManagerUrls(this.urls, rawUrls, { strictHttps: true, allowLoopbackHttp: hasLocalInitial });
    if (!merged.length) return false;
    this.urls = merged;
    if (current) {
      const idx = this.urls.indexOf(current);
      this.activeIndex = idx >= 0 ? idx : 0;
    }
    const changed = merged.join(',') !== beforeKey;
    if (changed) {
      persistCachedManagerUrls(this.urls, this.cacheFilePath);
    }
    return changed;
  }

  learnFromResponse(response, body) {
    const headerUrls = typeof response?.headers?.get === 'function' ? response.headers.get('x-manager-urls') : '';
    const bodyUrls = Array.isArray(body?.managerUrls) ? body.managerUrls : [];
    if (headerUrls || bodyUrls.length) {
      return this.learn([bodyUrls, headerUrls]);
    }
    return false;
  }
}

module.exports = {
  DEFAULT_MANAGER_URL,
  MAX_MANAGER_URLS,
  isPrivateOrInternalHost,
  normalizeManagerUrl,
  mergeManagerUrls,
  loadCachedManagerUrls,
  persistCachedManagerUrls,
  shouldFailoverResponse,
  ManagerUrlPool
};
