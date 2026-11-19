'use strict';

const zlib = require('node:zlib');
const express = require('express');
const helmet = require('helmet');
const { createRouter } = require('./routes');

function acceptsGzipEncoding(req) {
  const header = String(req?.headers?.['accept-encoding'] || '');
  let wildcardQuality = null;
  let gzipQuality = null;
  for (const entry of header.split(',')) {
    const [name, ...params] = entry.trim().toLowerCase().split(';');
    const qParam = params.find((p) => /^\s*q\s*=/.test(p));
    const quality = qParam ? Number(qParam.split('=')[1]) : 1;
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) continue;
    if (name === 'gzip') gzipQuality = quality;
    else if (name === '*') wildcardQuality = quality;
  }
  return gzipQuality !== null ? gzipQuality > 0 : wildcardQuality > 0;
}

function createApp(dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const acceptsGzip = acceptsGzipEncoding(req);
    const originalSend = res.send;
    res.send = function (body) {
      if (res.headersSent || !body || req.method === 'HEAD' || [204, 304].includes(res.statusCode)) {
        return originalSend.call(this, body);
      }
      const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
      const isCompressible = !contentType || contentType.includes('json') || contentType.includes('text');
      if (!isCompressible) return originalSend.call(this, body);
      res.vary('Accept-Encoding');
      if (!acceptsGzip || res.getHeader('Content-Encoding')) return originalSend.call(this, body);
      let buffer;
      try {
        buffer = Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      } catch (_) {
        return originalSend.call(this, body);
      }
      if (buffer.length < 512) return originalSend.call(this, body);
      zlib.gzip(buffer, { level: 5 }, (err, compressed) => {
        if (res.headersSent || res.destroyed) return;
        if (err) return originalSend.call(res, body);
        res.setHeader('Content-Encoding', 'gzip');
        res.removeHeader('Content-Length');
        originalSend.call(res, compressed);
      });
      return this;
    };
    next();
  });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use(createRouter(dependencies));
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    dependencies.logger?.error?.('http_request_failed', { name: error.name || 'Error', message: error.message });
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
    if (status === 400 || error.type === 'entity.parse.failed' || (error instanceof SyntaxError && 'body' in error)) {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    if (status === 413 || error.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'payload_too_large' });
    }
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      error: status === 404 ? 'not_found' : 'internal_error'
    });
  });
  return app;
}

module.exports = { createApp };

