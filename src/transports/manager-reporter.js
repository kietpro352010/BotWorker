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
    if (!response.ok) throw new Error(`manager_http_${response.status}`);
    this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
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

  async sendEvent(event) {
    // Redact any passwords from event message/reason before sending
    const sanitized = {
      ...event,
      message: event.message ? redactAuditValue(event.message) : undefined,
      reason: event.reason ? redactAuditValue(event.reason) : undefined,
      occurredAt: new Date().toISOString()
    };

    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/events`;
    return this.post(path, sanitized);
  }
}

module.exports = ManagerReporter;
