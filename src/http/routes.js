'use strict';

const express = require('express');
const { requireWorkerSecret, safeEqual, extractWorkerToken } = require('./auth');
const { ACTIONS } = require('../services/worker-runtime');

function attachBotRoutes(router, fleet, workerId, { legacy = false } = {}) {
  const resolveInstance = (req, res, next) => {
    const instance = fleet.get(workerId || req.params.workerId);
    if (!instance) return res.status(404).json({ ok: false, error: 'worker_not_found' });
    req.workerInstance = instance;
    return requireWorkerSecret(instance.config.secret)(req, res, next);
  };

  const prefix = legacy ? '/api/v1' : `/api/v1/bots/:workerId`;
  router.get(`${prefix}/status`, resolveInstance, (req, res) => {
    res.json({ ok: true, worker: req.workerInstance.runtime.status() });
  });

  router.post(`${prefix}/command`, resolveInstance, async (req, res, next) => {
    const action = String(req.body?.action || '').trim().toLowerCase();
    if (!ACTIONS.has(action)) return res.status(400).json({ ok: false, error: 'unsupported_action' });
    try {
      const result = await req.workerInstance.runtime.execute(action, req.body?.payload || {});
      return res.json({ ok: true, result });
    } catch (error) {
      const msg = error.message || '';
      let status = 400;
      if (error.status && Number.isInteger(error.status) && error.status >= 400 && error.status < 600) {
        status = error.status;
      } else if (error.code === 'ETIMEDOUT' || /timed out/i.test(msg)) {
        status = 504;
      } else if (error.code === 'QUEUE_BUSY' || /queue is busy/i.test(msg)) {
        status = 503;
      } else if (error.code === 'RATE_LIMIT' || /rate limit/i.test(msg)) {
        status = 429;
      } else if (error.code === 'LIFECYCLE_CONFLICT' || /already in progress|conflicting/i.test(msg)) {
        status = 409;
      } else if (/unsupported|payload/i.test(msg)) {
        status = 400;
      }
      return res.status(status).json({ ok: false, error: msg || 'command_failed', code: error.code || null });
    }
  });

  if (legacy) {
    router.post('/api/v1/event', resolveInstance, async (req, res) => {
      await req.workerInstance.reporter?.sendEvent({
        type: String(req.body?.type || '').slice(0, 48),
        message: String(req.body?.message || '').slice(0, 300)
      }).catch(() => {});
      return res.json({ ok: true });
    });
  }
}

function createRouter({ fleet, config }) {
  const router = express.Router();

  router.get(['/', '/health'], (_req, res) => res.json({
    ok: true,
    service: 'kingmc-afk-worker',
    botCount: config.botCount
  }));

  router.get('/api/v1/diagnostics', (req, res) => {
    const secret = extractWorkerToken(req);
    const authed = Array.isArray(config.bots) && config.bots.some((b) => safeEqual(secret, b.secret));
    if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });
    return res.json({
      ok: true,
      service: 'kingmc-afk-worker',
      botCount: config.botCount,
      resource: fleet.health()
    });
  });

  attachBotRoutes(router, fleet);

  if (config.botCount === 1) {
    const workerId = config.bots[0].workerId;
    attachBotRoutes(router, fleet, workerId, { legacy: true });
  }

  return router;
}

module.exports = { createRouter };
