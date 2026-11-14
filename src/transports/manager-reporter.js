'use strict';

const { redactAuditValue } = require('../game/server-auth');
const { computeBotStateDigest } = require('../domain/worker-state');

class ManagerReporter {
  constructor({ baseUrl, workerId, secret, fetchImpl = global.fetch, logger }) {
    this.baseUrl = baseUrl;
    this.workerId = workerId;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.managerLatencyMs = null;
    this.lastReportedPosition = null;
    this.lastStateDigest = null;
    this.lastFullReportAt = 0;
    this.eventQueue = [];
    this.eventFlushTimer = null;
  }

  hasPositionMovedSignificantly(newPos) {
    if (!newPos || !Number.isFinite(newPos.x)) return false;
    if (!this.lastReportedPosition) {
      this.lastReportedPosition = { ...newPos };
      return true;
    }
    const dx = newPos.x - this.lastReportedPosition.x;
    const dy = (newPos.y || 0) - (this.lastReportedPosition.y || 0);
    const dz = newPos.z - this.lastReportedPosition.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= 25.0) { // >= 5.0 blocks (matched with RPC record_bot_position_change)
      this.lastReportedPosition = { ...newPos };
      return true;
    }
    return false;
  }

  async post(path, payload) {
    if (!this.baseUrl || !this.fetch) return;
    const startedAt = Date.now();
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': this.secret,
        'x-manager-bot-id': String(this.workerId)
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (body && typeof body.ok === 'boolean' && !body.ok)) {
      throw new Error(body?.error || `manager_http_${response.status}`);
    }
    this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
    return body;
  }

  async heartbeat(status) {
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/heartbeat`;
    const now = Date.now();
    const digest = computeBotStateDigest(status);
    const digestUnchanged = this.lastStateDigest === digest && (now - this.lastFullReportAt < 60000);

    const sanitizedStatus = {
      ...status,
      managerLatencyMs: this.managerLatencyMs,
      stateDigest: digest,
      digestUnchanged
    };

    if (digestUnchanged) {
      sanitizedStatus.isLightweight = true;
    } else {
      this.lastStateDigest = digest;
      this.lastFullReportAt = now;
    }

    if (status.position) {
      if (!this.hasPositionMovedSignificantly(status.position)) {
        sanitizedStatus.positionUnchanged = true;
      }
    }

    return this.post(path, {
      status: sanitizedStatus,
      sentAt: new Date().toISOString()
    });
  }

  async bootstrap() {
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/bootstrap`;
    const startedAt = Date.now();
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      headers: {
        'x-worker-secret': this.secret,
        'x-manager-bot-id': String(this.workerId)
      },
      signal: AbortSignal.timeout(8000)
    });
    this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `manager_http_${response.status}`);
    return body;
  }

  enqueueEvent(event) {
    const sanitized = {
      ...event,
      message: event?.message ? redactAuditValue(event.message) : undefined,
      reason: event?.reason ? redactAuditValue(event.reason) : undefined,
      occurredAt: event?.occurredAt || new Date().toISOString()
    };
    delete sanitized.password;
    delete sanitized.token;

    if (this.eventQueue.length >= 100) {
      this.eventQueue.shift(); // Bound queue to prevent memory leak
    }

    this.eventQueue.push({
      event: sanitized,
      attempts: 0,
      nextRetryAt: 0
    });

    this.scheduleFlush(0);
  }

  scheduleFlush(delayMs = 1000) {
    if (this.eventFlushTimer) return;
    this.eventFlushTimer = setTimeout(() => {
      this.eventFlushTimer = null;
      void this.flushEventQueue();
    }, delayMs);
    this.eventFlushTimer.unref?.();
  }

  async flushEventQueue() {
    if (!this.eventQueue.length) return;
    const now = Date.now();
    const remaining = [];
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/events`;

    for (const item of this.eventQueue) {
      if (now < item.nextRetryAt) {
        remaining.push(item);
        continue;
      }

      try {
        await this.post(path, item.event);
      } catch (err) {
        item.attempts += 1;
        const backoffMs = Math.min(60000, 1000 * Math.pow(2, Math.min(item.attempts, 5)));
        item.nextRetryAt = Date.now() + backoffMs;
        remaining.push(item);
        this.logger?.warn?.('manager_event_delivery_retry', {
          workerId: this.workerId,
          attempts: item.attempts,
          nextRetryInMs: backoffMs,
          error: err.message
        });
      }
    }

    this.eventQueue = remaining;
    if (this.eventQueue.length > 0) {
      const nextDelay = Math.max(100, Math.min(...this.eventQueue.map((i) => Math.max(0, i.nextRetryAt - Date.now()))));
      this.scheduleFlush(nextDelay);
    }
  }

  async sendEvent(event) {
    this.enqueueEvent(event);
    return this.flushEventQueue();
  }

  stop() {
    if (this.eventFlushTimer) {
      clearTimeout(this.eventFlushTimer);
      this.eventFlushTimer = null;
    }
  }
}

module.exports = ManagerReporter;
