'use strict';

const express = require('express');
const { requireWorkerSecret, safeEqual, extractWorkerToken } = require('./auth');
const { ACTIONS } = require('../services/worker-runtime');

function matchesBotSecret(supplied, bot) {
  if (!supplied || !bot) return false;
  if (bot.secret && safeEqual(supplied, bot.secret)) return true;
  if (bot.previousSecret && Date.now() < (Number(bot.graceUntil) || 0) && safeEqual(supplied, bot.previousSecret)) {
    return true;
  }
  return false;
}

function attachBotRoutes(router, fleet, workerId, { legacy = false, config = null } = {}) {
  // RT-04: Secure instance resolution avoiding workerId enumeration
  const resolveInstance = (req, res, next) => {
    const supplied = extractWorkerToken(req);
    if (!supplied) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const targetId = workerId || req.params.workerId;
    const instance = typeof fleet?.get === 'function' ? fleet.get(targetId) : null;

    if (!instance) {
      const knownBots = (config?.bots && Array.isArray(config.bots))
        ? config.bots
        : (typeof fleet?.list === 'function' ? fleet.list() : []).map((i) => i?.config).filter(Boolean);
      const isKnownCaller = knownBots.some((b) => matchesBotSecret(supplied, b));

      if (!isKnownCaller) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      return res.status(404).json({ ok: false, error: 'worker_not_found' });
    }

    req.workerInstance = instance;
    const authFn = requireWorkerSecret(instance.config.secret, {
      previousSecret: instance.config.previousSecret,
      graceUntil: instance.config.graceUntil
    });
    return authFn(req, res, next);
  };

  const prefix = legacy ? '/api/v1' : `/api/v1/bots/:workerId`;
  router.get(`${prefix}/status`, resolveInstance, (req, res) => {
    res.json({ ok: true, worker: req.workerInstance.runtime.status() });
  });

  // RT-01, RT-02, RT-03: Robust, cancellable, sanitized command handler
  router.post(`${prefix}/command`, resolveInstance, async (req, res, next) => {
    let abortController = null;
    let onClose = null;

    try {
      const action = String(req.body?.action || '').trim().toLowerCase();
      if (!ACTIONS.has(action)) {
        return res.status(400).json({ ok: false, error: 'unsupported_action' });
      }

      // RT-02: Strict payload type validation & stripping internal timeout fields
      const rawPayload = req.body?.payload;
      if (rawPayload !== undefined && (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload))) {
        return res.status(400).json({
          ok: false,
          error: 'Command payload must be an object.',
          code: 'INVALID_PAYLOAD'
        });
      }
      const sanitizedPayload = rawPayload ? { ...rawPayload } : {};
      delete sanitizedPayload.timeoutMs;
      delete sanitizedPayload.execTimeoutMs;
      delete sanitizedPayload.queueTimeoutMs;

      // RT-01: AbortController linked to HTTP connection lifecycle
      abortController = new AbortController();
      onClose = () => {
        if (!res.writableEnded) {
          abortController.abort(new Error('http_request_aborted'));
        }
      };
      res.on('close', onClose);

      const result = await req.workerInstance.runtime.execute(
        action,
        sanitizedPayload,
        { signal: abortController.signal }
      );

      if (res.writableEnded || res.headersSent || res.destroyed) return;
      return res.json({ ok: true, result });
    } catch (error) {
      if (res.writableEnded || res.headersSent || res.destroyed) return;

      // RT-03: Safe error property extraction with null-guards
      const msg = (error && typeof error === 'object' && error.message)
        ? String(error.message)
        : (typeof error === 'string' ? error : '');
      const code = (error && typeof error === 'object' && error.code) ? String(error.code) : null;
      const errStatus = (error && typeof error === 'object' && Number.isInteger(error.status)) ? error.status : null;

      let status = 400;
      if (errStatus && errStatus >= 400 && errStatus < 600) {
        status = errStatus;
      } else if (code === 'ETIMEDOUT' || /timed out/i.test(msg)) {
        status = 504;
      } else if (code === 'QUEUE_BUSY' || /queue is busy/i.test(msg)) {
        status = 503;
      } else if (code === 'RATE_LIMIT' || /rate limit/i.test(msg)) {
        status = 429;
      } else if (code === 'LIFECYCLE_CONFLICT' || /already in progress|conflicting/i.test(msg)) {
        status = 409;
      } else if (code === 'INVALID_PAYLOAD' || code === 'UNSUPPORTED_ACTION' || /unsupported|payload/i.test(msg)) {
        status = 400;
      } else if (code === 'ABORT_ERR' || code === 'COMMAND_ABORTED' || /aborted/i.test(msg)) {
        // Only suppress response when the HTTP client itself actually disconnected;
        // internal AbortSignal timeouts (e.g. fetch timeout) MUST still respond with 504.
        if (abortController?.signal?.aborted || req.aborted || res.destroyed) {
          return;
        }
        status = 504;
      }

      return res.status(status).json({ ok: false, error: msg || 'command_failed', code: code || (status === 504 ? 'ETIMEDOUT' : null) });
    } finally {
      if (onClose) {
        res.removeListener('close', onClose);
      }
    }
  });

  // RT-05: Non-blocking, validated legacy event reporting
  if (legacy) {
    router.post('/api/v1/event', resolveInstance, (req, res) => {
      const type = typeof req.body?.type === 'string' ? req.body.type.trim() : '';
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

      if (!type || !message) {
        return res.status(400).json({
          ok: false,
          error: 'invalid_event',
          message: 'Event type and message are required.'
        });
      }

      const reporter = req.workerInstance.reporter;
      if (typeof reporter?.enqueueEvent === 'function') {
        reporter.enqueueEvent({
          type: type.slice(0, 48),
          message: message.slice(0, 300)
        });
      } else if (typeof reporter?.sendEvent === 'function') {
        void reporter.sendEvent({
          type: type.slice(0, 48),
          message: message.slice(0, 300)
        }).catch(() => {});
      }

      return res.json({ ok: true, queued: true });
    });
  }
}

function createRouter({ fleet, config }) {
  const router = express.Router();

  // RT-04: Omit sensitive workerId list from unauthenticated probe endpoint
  router.get(['/', '/health'], (_req, res) => res.json({
    ok: true,
    service: 'kingmc-afk-worker',
    botCount: config?.botCount ?? 0,
    slots: Array.isArray(config?.bots)
      ? config.bots.map((b, idx) => (Number.isInteger(b?.slot) ? b.slot : idx + 1))
      : []
  }));

  router.get('/ready', (_req, res) => res.json({
    ok: true,
    ready: true,
    service: 'kingmc-afk-worker',
    botCount: config?.botCount ?? 0
  }));

  router.get('/api/v1/diagnostics', (req, res) => {
    const secret = extractWorkerToken(req);
    const authed = Array.isArray(config?.bots) && config.bots.some((b) => matchesBotSecret(secret, b));
    if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });
    return res.json({
      ok: true,
      service: 'kingmc-afk-worker',
      botCount: config.botCount,
      bots: Array.isArray(config?.bots)
        ? config.bots.map((b, idx) => ({ workerId: b.workerId, slot: Number.isInteger(b?.slot) ? b.slot : idx + 1 }))
        : [],
      resource: fleet.health()
    });
  });

  attachBotRoutes(router, fleet, null, { config });

  if (config?.botCount === 1 && config.bots?.[0]?.workerId) {
    const workerId = config.bots[0].workerId;
    attachBotRoutes(router, fleet, workerId, { legacy: true, config });
  }

  return router;
}

module.exports = { createRouter };
