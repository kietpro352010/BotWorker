'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const express = require('express');
const helmet = require('helmet');
const { createRouter } = require('./routes');

const SAFE_REQUEST_ID_REGEX = /^[A-Za-z0-9._:-]{8,64}$/;
const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeObjectInPlace(target, depth = 0) {
  if (!target || typeof target !== 'object' || depth > 12) return target;
  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      sanitizeObjectInPlace(target[i], depth + 1);
    }
    return target;
  }
  for (const key of Object.keys(target)) {
    if (DANGEROUS_PROTO_KEYS.has(key)) {
      delete target[key];
    } else {
      sanitizeObjectInPlace(target[key], depth + 1);
    }
  }
  return target;
}

function negotiateWorkerEncoding(req) {
  const header = String(req?.headers?.['accept-encoding'] || '');
  let wildcardQuality = null;
  let brQuality = null;
  let gzipQuality = null;
  for (const entry of header.split(',')) {
    const [rawName, ...params] = entry.trim().toLowerCase().split(';');
    const name = rawName.trim();
    if (!name) continue;
    const qParam = params.find((p) => /^\s*q\s*=/.test(p));
    const quality = qParam ? Number(qParam.split('=')[1]) : 1;
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) continue;
    if (name === 'br') brQuality = quality;
    else if (name === 'gzip') gzipQuality = quality;
    else if (name === '*') wildcardQuality = quality;
  }
  const brAllowed = brQuality !== null ? brQuality > 0 : wildcardQuality > 0;
  const gzipAllowed = gzipQuality !== null ? gzipQuality > 0 : wildcardQuality > 0;
  if (brAllowed && typeof zlib.brotliCompress === 'function') {
    if (brQuality === null || gzipQuality === null || brQuality >= gzipQuality) {
      return 'br';
    }
  }
  if (gzipAllowed) return 'gzip';
  return null;
}

function createApp(dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const encoding = negotiateWorkerEncoding(req);
    const originalSend = res.send;
    res.send = function (body) {
      if (res.headersSent || !body || req.method === 'HEAD' || [204, 304].includes(res.statusCode)) {
        return originalSend.call(this, body);
      }
      const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
      const isCompressible = !contentType || contentType.includes('json') || contentType.includes('text');
      if (!isCompressible) return originalSend.call(this, body);
      res.vary('Accept-Encoding');
      if (!encoding || res.getHeader('Content-Encoding')) return originalSend.call(this, body);
      let buffer;
      try {
        buffer = Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      } catch (_) {
        return originalSend.call(this, body);
      }
      if (buffer.length < 512) return originalSend.call(this, body);
      if (encoding === 'br') {
        zlib.brotliCompress(
          buffer,
          {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
              [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT
            }
          },
          (err, compressed) => {
            if (res.headersSent || res.destroyed) return;
            if (err) return originalSend.call(res, body);
            res.setHeader('Content-Encoding', 'br');
            res.removeHeader('Content-Length');
            originalSend.call(res, compressed);
          }
        );
        return this;
      }
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
  app.use((req, res, next) => {
    const incomingId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : '';
    req.requestId = SAFE_REQUEST_ID_REGEX.test(incomingId) ? incomingId : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object') sanitizeObjectInPlace(req.body);
    if (req.query && typeof req.query === 'object') sanitizeObjectInPlace(req.query);
    next();
  });
  app.use(createRouter(dependencies));
  app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found', requestId: req.requestId }));
  app.use((error, req, res, _next) => {
    dependencies.logger?.error?.('http_request_failed', {
      requestId: req?.requestId,
      name: error.name || 'Error',
      message: error.message
    });
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
    if (status === 400 || error.type === 'entity.parse.failed' || (error instanceof SyntaxError && 'body' in error)) {
      return res.status(400).json({ ok: false, error: 'invalid_json', requestId: req?.requestId });
    }
    if (status === 413 || error.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'payload_too_large', requestId: req?.requestId });
    }
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      error: status === 404 ? 'not_found' : 'internal_error',
      requestId: req?.requestId
    });
  });
  return app;
}

module.exports = { createApp };

