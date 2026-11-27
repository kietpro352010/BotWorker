'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const NATIVE_GLOBAL_FETCH = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

let sharedHttpAgent = null;
let sharedHttpsAgent = null;

function getSharedAgents() {
  if (!sharedHttpAgent) {
    sharedHttpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 6,
      maxFreeSockets: 2,
      timeout: 65000
    });
  }
  if (!sharedHttpsAgent) {
    sharedHttpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 6,
      maxFreeSockets: 2,
      timeout: 65000
    });
  }
  return { httpAgent: sharedHttpAgent, httpsAgent: sharedHttpsAgent };
}

function closeWorkerHttpAgents() {
  if (sharedHttpAgent) {
    try { sharedHttpAgent.destroy(); } catch (_) {}
    sharedHttpAgent = null;
  }
  if (sharedHttpsAgent) {
    try { sharedHttpsAgent.destroy(); } catch (_) {}
    sharedHttpsAgent = null;
  }
}

function computeUrlsSignature(urls = []) {
  if (!Array.isArray(urls) || !urls.length) return '';
  const canonical = [...new Set(urls.map((u) => String(u || '').trim()).filter(Boolean))].sort().join(',');
  if (!canonical) return '';
  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 8);
}

function createHeadersAdapter(rawHeaders = {}) {
  return {
    get(name) {
      if (!name) return null;
      const val = rawHeaders[String(name).toLowerCase()];
      if (val === undefined || val === null) return null;
      return Array.isArray(val) ? val.join(', ') : String(val);
    }
  };
}

function normalizeRequestHeaders(headers = {}, bodyBuffer = null) {
  const normalized = {};
  if (headers && typeof headers === 'object') {
    for (const [key, val] of Object.entries(headers)) {
      if (val === undefined || val === null) continue;
      normalized[String(key).toLowerCase()] = String(val);
    }
  }
  if (!normalized['accept-encoding']) {
    normalized['accept-encoding'] = 'br, gzip, deflate';
  }
  if (bodyBuffer !== null && normalized['content-length'] === undefined) {
    normalized['content-length'] = String(bodyBuffer.length);
  }
  return normalized;
}

function createDecompressorStream(contentEncoding) {
  const enc = String(contentEncoding || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return null;
  if (enc.includes('br')) return zlib.createBrotliDecompress();
  if (enc.includes('gzip')) return zlib.createGunzip();
  if (enc.includes('deflate')) return zlib.createInflate();
  return null;
}

function isCompressedEncoding(contentEncoding) {
  const enc = String(contentEncoding || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return false;
  return enc.includes('br') || enc.includes('gzip') || enc.includes('deflate');
}

function createAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = new Error(typeof signal?.reason === 'string' && signal.reason ? signal.reason : 'The operation was aborted.');
  err.name = signal?.reason?.name || 'AbortError';
  return err;
}

function workerFetch(urlStr, options = {}) {
  const signal = options.signal || null;
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal));
  }

  let parsed;
  try {
    parsed = new URL(String(urlStr));
  } catch {
    return Promise.reject(new Error(`Invalid URL: ${String(urlStr).slice(0, 120)}`));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Promise.reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
  }

  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const { httpAgent, httpsAgent } = getSharedAgents();
  const agent = options.agent || (isHttps ? httpsAgent : httpAgent);
  const method = String(options.method || 'GET').toUpperCase();
  const connectTimeoutMs = Math.max(500, Math.min(30000, Number(options.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS));
  const maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_RESPONSE_BYTES);
  const truncateOnMaxBytes = options.truncateOnMaxBytes === true;

  let bodyBuffer = null;
  if (options.body !== undefined && options.body !== null) {
    bodyBuffer = Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body), 'utf8');
  }

  const headers = normalizeRequestHeaders(options.headers, bodyBuffer);

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer = null;
    let attachedSocket = null;
    const clearConnectTimer = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (attachedSocket) {
        attachedSocket.removeListener('connect', clearConnectTimer);
        attachedSocket.removeListener('secureConnect', clearConnectTimer);
        attachedSocket.removeListener('error', clearConnectTimer);
        attachedSocket.removeListener('close', clearConnectTimer);
        attachedSocket = null;
      }
    };

    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      agent
    });

    const onAbort = () => {
      const err = createAbortError(signal);
      clearConnectTimer();
      req.destroy(err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const detachAbort = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    req.on('socket', (socket) => {
      if (!socket) return;
      try { socket.setNoDelay?.(true); } catch (_) {}
      if (!socket.connecting) return;
      attachedSocket = socket;
      connectTimer = setTimeout(() => {
        const err = new Error(`TCP/TLS connect timeout after ${connectTimeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      }, connectTimeoutMs);
      connectTimer.unref?.();
      socket.once(isHttps ? 'secureConnect' : 'connect', clearConnectTimer);
      socket.once('error', clearConnectTimer);
      socket.once('close', clearConnectTimer);
    });

    req.once('timeout', () => {
      const err = new Error('HTTP request socket idle timeout');
      err.code = 'ETIMEDOUT';
      clearConnectTimer();
      req.destroy(err);
    });

    req.once('error', (err) => {
      clearConnectTimer();
      detachAbort();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    req.once('response', (res) => {
      clearConnectTimer();
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;

      const contentEncoding = res.headers['content-encoding'];
      const needsDecompress = isCompressedEncoding(contentEncoding);
      let bodyConsumed = false;
      let bodyCancelled = false;
      let bodyPromise = null;
      let decoder = null;

      const destroyDecoder = () => {
        if (!decoder) return;
        const d = decoder;
        decoder = null;
        try {
          d.removeAllListeners('data');
          d.removeAllListeners('end');
          d.removeAllListeners('drain');
          if (d.listenerCount('error') === 0) d.on('error', () => {});
        } catch (_) {}
        try { d.destroy(); } catch (_) {}
        try { d.close?.(); } catch (_) {}
      };

      const readDecodedBuffer = () => {
        if (bodyPromise) return bodyPromise;
        bodyPromise = new Promise((resolveBody, rejectBody) => {
          if (bodyCancelled || res.destroyed) {
            detachAbort();
            destroyDecoder();
            return resolveBody(Buffer.alloc(0));
          }
          if (signal?.aborted) {
            detachAbort();
            destroyDecoder();
            res.destroy();
            return rejectBody(createAbortError(signal));
          }
          const chunks = [];
          let totalBytes = 0;
          let wireBytes = 0;
          let settledBody = false;

          const cleanupBodyListeners = () => {
            detachAbort();
            if (signal) signal.removeEventListener('abort', onBodyAbort);
            res.removeListener('data', onResData);
            res.removeListener('end', onResEnd);
            res.removeListener('error', onStreamErr);
            res.removeListener('aborted', onResAborted);
            res.removeListener('timeout', onResTimeout);
          };

          const onBodyAbort = () => {
            if (settledBody) return;
            settledBody = true;
            cleanupBodyListeners();
            destroyDecoder();
            res.destroy();
            rejectBody(createAbortError(signal));
          };

          const onResTimeout = () => {
            if (settledBody) return;
            settledBody = true;
            cleanupBodyListeners();
            destroyDecoder();
            const err = new Error('Response stream idle timeout');
            err.code = 'ETIMEDOUT';
            res.destroy(err);
            rejectBody(err);
          };

          const onStreamErr = (err) => {
            if (settledBody) return;
            settledBody = true;
            cleanupBodyListeners();
            destroyDecoder();
            if (!res.destroyed) res.destroy();
            rejectBody(err);
          };

          const onResAborted = () => {
            if (settledBody) return;
            settledBody = true;
            cleanupBodyListeners();
            destroyDecoder();
            if (signal?.aborted) rejectBody(createAbortError(signal));
            else rejectBody(new Error('Response stream aborted'));
          };

          const finishBody = () => {
            if (settledBody) return;
            settledBody = true;
            bodyConsumed = true;
            cleanupBodyListeners();
            destroyDecoder();
            resolveBody(totalBytes > 0 ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0));
          };

          const pushDecodedChunk = (chunk) => {
            if (settledBody || !chunk || chunk.length === 0) return;
            const remaining = maxBytes - totalBytes;
            if (remaining <= 0 || chunk.length > remaining) {
              if (truncateOnMaxBytes) {
                if (remaining > 0) {
                  chunks.push(chunk.subarray(0, remaining));
                  totalBytes += remaining;
                }
                settledBody = true;
                bodyConsumed = true;
                cleanupBodyListeners();
                destroyDecoder();
                res.destroy();
                resolveBody(totalBytes > 0 ? Buffer.concat(chunks, totalBytes) : Buffer.alloc(0));
                return;
              }
              settledBody = true;
              cleanupBodyListeners();
              destroyDecoder();
              const err = new Error(`Response body exceeded maxBytes limit (${maxBytes})`);
              err.code = 'ERR_RESPONSE_TOO_LARGE';
              res.destroy(err);
              rejectBody(err);
              return;
            }
            chunks.push(chunk);
            totalBytes += chunk.length;
          };

          const onResData = (rawChunk) => {
            if (settledBody || !rawChunk || rawChunk.length === 0) return;
            wireBytes += rawChunk.length;
            if (!truncateOnMaxBytes && wireBytes > maxBytes) {
              settledBody = true;
              cleanupBodyListeners();
              destroyDecoder();
              const err = new Error(`Response body exceeded maxBytes limit (${maxBytes})`);
              err.code = 'ERR_RESPONSE_TOO_LARGE';
              res.destroy(err);
              rejectBody(err);
              return;
            }
            if (!needsDecompress) {
              pushDecodedChunk(rawChunk);
              return;
            }
            if (!decoder) {
              decoder = createDecompressorStream(contentEncoding);
              if (!decoder) {
                pushDecodedChunk(rawChunk);
                return;
              }
              decoder.on('data', pushDecodedChunk);
              decoder.once('end', finishBody);
              decoder.once('error', onStreamErr);
            }
            const canContinue = decoder.write(rawChunk);
            if (!canContinue && !settledBody && !res.destroyed) {
              res.pause();
              decoder.once('drain', () => {
                if (!settledBody && !res.destroyed) res.resume();
              });
            }
          };

          const onResEnd = () => {
            if (settledBody) return;
            if (decoder) {
              decoder.end();
            } else {
              finishBody();
            }
          };

          if (signal) signal.addEventListener('abort', onBodyAbort, { once: true });
          res.on('data', onResData);
          res.once('end', onResEnd);
          res.once('error', onStreamErr);
          res.once('aborted', onResAborted);
          res.once('timeout', onResTimeout);
        });
        return bodyPromise;
      };

      const status = Number(res.statusCode || 0);
      const responseObj = {
        ok: status >= 200 && status < 300,
        status,
        headers: createHeadersAdapter(res.headers),
        async text() {
          const decoded = await readDecodedBuffer();
          return decoded.length ? decoded.toString('utf8') : '';
        },
        async json() {
          const txt = await this.text();
          if (!txt) throw new SyntaxError('Unexpected end of JSON input');
          return JSON.parse(txt);
        },
        body: {
          async cancel() {
            bodyCancelled = true;
            detachAbort();
            destroyDecoder();
            if (!bodyConsumed && !res.destroyed) {
              res.destroy();
            }
          }
        }
      };

      resolve(responseObj);
    });

    if (bodyBuffer !== null && bodyBuffer.length > 0) {
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

function resolveWorkerFetch(explicitFetch = undefined) {
  if (typeof explicitFetch === 'function') return explicitFetch;
  if (typeof globalThis.fetch === 'function' && globalThis.fetch !== NATIVE_GLOBAL_FETCH) {
    return globalThis.fetch;
  }
  return workerFetch;
}

module.exports = {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  getSharedAgents,
  closeWorkerHttpAgents,
  computeUrlsSignature,
  workerFetch,
  resolveWorkerFetch
};
