'use strict';

const crypto = require('node:crypto');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function requireWorkerSecret(secret) {
  return (req, res, next) => {
    const supplied = req.get('x-worker-secret') || '';
    if (!safeEqual(supplied, secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  };
}

module.exports = { safeEqual, requireWorkerSecret };

