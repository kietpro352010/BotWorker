'use strict';

const crypto = require('node:crypto');

function safeEqual(a, b) {
  if (typeof a !== 'string' && !Buffer.isBuffer(a)) return false;
  if (typeof b !== 'string' && !Buffer.isBuffer(b)) return false;
  const strA = String(a);
  const strB = String(b);
  if (!strA || !strB) return false;
  const hashA = crypto.createHash('sha256').update(strA).digest();
  const hashB = crypto.createHash('sha256').update(strB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function extractWorkerToken(req) {
  if (!req || typeof req.get !== 'function') return '';
  const headerSecret = req.get('x-worker-secret');
  if (headerSecret && typeof headerSecret === 'string') {
    const trimmed = headerSecret.trim();
    if (trimmed) return trimmed;
  }
  const authHeader = req.get('authorization');
  if (authHeader && typeof authHeader === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return '';
}

function requireWorkerSecret(secret, { previousSecret = null, graceUntil = 0 } = {}) {
  return (req, res, next) => {
    const supplied = extractWorkerToken(req);
    if (safeEqual(supplied, secret)) return next();
    if (previousSecret && Date.now() < graceUntil && safeEqual(supplied, previousSecret)) {
      return next();
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  };
}

module.exports = { safeEqual, extractWorkerToken, requireWorkerSecret };
