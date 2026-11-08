'use strict';

const express = require('express');
const { requireWorkerSecret } = require('./auth');
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
    } catch (error) { return next(error); }
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
    botCount: config.botCount,
    resource: fleet.health()
  }));

  attachBotRoutes(router, fleet);

  if (config.botCount === 1) {
    const workerId = config.bots[0].workerId;
    attachBotRoutes(router, fleet, workerId, { legacy: true });
  }

  return router;
}

module.exports = { createRouter };
