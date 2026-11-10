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

function requireWorkerSecret(secret) {
  return (req, res, next) => {
    const supplied = req.get('x-worker-secret') || '';
    if (!safeEqual(supplied, secret)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  };
}

module.exports = { safeEqual, requireWorkerSecret };
