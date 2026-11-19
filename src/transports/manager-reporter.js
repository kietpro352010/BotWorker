'use strict';

const { redactAuditValue } = require('../game/server-auth');
const { computeBotStateDigest } = require('../domain/worker-state');

class ManagerReporter {
  constructor({ baseUrl, workerId, secret, fetchImpl = global.fetch, logger, onSettingsChanged = null }) {
    this.baseUrl = baseUrl;
    this.workerId = workerId;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.onSettingsChanged = typeof onSettingsChanged === 'function' ? onSettingsChanged : null;
    this.lastSettingsRevision = null;
    this.managerLatencyMs = null;
    this.lastReportedPosition = null;
    this.lastStateDigest = null;
    this.lastFullReportAt = 0;
    this.statusSeq = 0;
    this.lastRecordedStatusSeq = 0;
    this.eventQueue = [];
    this.eventFlushTimer = null;
    this.flushPromise = null;
    this.pendingHeartbeat = null;
    this.heartbeatPromise = null;
    this.stopping = false;
  }

  hasPositionMovedSignificantly(newPos) {
    if (!newPos || !Number.isFinite(newPos.x)) return false;
    if (!this.lastReportedPosition) return true;
    const dx = newPos.x - this.lastReportedPosition.x;
    const dy = (newPos.y || 0) - (this.lastReportedPosition.y || 0);
    const dz = newPos.z - this.lastReportedPosition.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    return distSq >= 25.0; // >= 5.0 blocks (matched with RPC record_bot_position_change)
  }

  async post(path, payload, { signal } = {}) {
    if (!this.baseUrl || !this.fetch || this.stopping) return;
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(8000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-secret': this.secret,
        'x-manager-bot-id': String(this.workerId)
      },
      body: JSON.stringify(payload),
      signal: combinedSignal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (body && typeof body.ok === 'boolean' && !body.ok)) {
      const err = new Error(body?.error || `manager_http_${response.status}`);
      err.status = response.status;
      throw err;
    }
    this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
    return body;
  }

  async heartbeat(status, { signal } = {}) {
    this.pendingHeartbeat = status;
    if (this.heartbeatPromise) return this.heartbeatPromise;

    this.heartbeatPromise = this.flushHeartbeats({ signal }).finally(() => {
      this.heartbeatPromise = null;
      if (this.pendingHeartbeat && !this.stopping) {
        const nextStatus = this.pendingHeartbeat;
        void this.heartbeat(nextStatus).catch((error) => {
          this.logger?.warn?.('manager_heartbeat_failed', { workerId: this.workerId, error: error.message });
        });
      }
    });
    return this.heartbeatPromise;
  }

  async flushHeartbeats({ signal } = {}) {
    while (this.pendingHeartbeat && !this.stopping) {
      const status = this.pendingHeartbeat;
      this.pendingHeartbeat = null;
      await this.sendHeartbeat(status, { signal });
    }
  }

  prepareStatusPayload(status) {
    const now = Date.now();
    const raw = status && typeof status === 'object' ? status : {};
    const seq = ++this.statusSeq;
    const digest = computeBotStateDigest(raw);
    const digestUnchanged = this.lastStateDigest === digest && (now - this.lastFullReportAt < 300000);
    const positionMoved = Boolean(raw.position && this.hasPositionMovedSignificantly(raw.position));

    const payload = {
      ...raw,
      managerLatencyMs: this.managerLatencyMs,
      stateDigest: digest,
      digestUnchanged
    };

    if (digestUnchanged) {
      payload.isLightweight = true;
      delete payload.inventory;
      delete payload.currentWindow;
      delete payload.items;
      delete payload.bandwidthRxBps;
      delete payload.bandwidthTxBps;
      delete payload.processStartedAt;
      delete payload.pendingCommands;
      delete payload.activeLifecycle;
      delete payload.locationKind;
      if (!positionMoved) {
        delete payload.position;
        payload.positionUnchanged = true;
      }
    } else if (raw.position && !positionMoved) {
      payload.positionUnchanged = true;
    }

    return { seq, payload, digest, digestUnchanged, positionMoved, position: raw.position || null };
  }

  recordStatusSent(meta) {
    if (!meta) return;
    if (Number.isInteger(meta.seq)) {
      if (meta.seq < this.lastRecordedStatusSeq) return;
      this.lastRecordedStatusSeq = meta.seq;
    }
    if (!meta.digestUnchanged) {
      this.lastStateDigest = meta.digest;
      this.lastFullReportAt = Date.now();
    }
    if (meta.positionMoved && meta.position) {
      this.lastReportedPosition = { ...meta.position };
    }
  }

  async sendHeartbeat(status, { signal } = {}) {
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/heartbeat`;
    const meta = this.prepareStatusPayload(status);
    const response = await this.post(path, {
      status: meta.payload,
      sentAt: new Date().toISOString()
    }, { signal });
    this.recordStatusSent(meta);
    if (response && response.settingsRevision !== undefined) {
      this.noteSettingsRevision(response.settingsRevision);
    }
    return response;
  }

  noteSettingsRevision(rev) {
    if (rev === undefined || rev === null) return;
    const prev = this.lastSettingsRevision;
    this.lastSettingsRevision = rev;
    if (prev !== null && prev !== rev && this.onSettingsChanged && !this.stopping) {
      void Promise.resolve().then(() => this.onSettingsChanged(rev)).catch(() => {});
    }
  }

  async bootstrap({ signal } = {}) {
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/bootstrap`;
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(8000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      headers: {
        'x-worker-secret': this.secret,
        'x-manager-bot-id': String(this.workerId)
      },
      signal: combinedSignal
    });
    this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      const err = new Error(body?.error || `manager_http_${response.status}`);
      err.status = response.status;
      throw err;
    }
    if (body.settingsRevision !== undefined) {
      this.lastSettingsRevision = body.settingsRevision;
    }
    return body;
  }

  enqueueEvent(event) {
    const sanitize = (value, depth = 0, seen = new WeakSet()) => {
      if (typeof value === 'string') return redactAuditValue(value);
      if (!value || typeof value !== 'object') return value;
      if (depth >= 4) return '[truncated]';
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1, seen));
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        if (/(?:password|token|authorization|credentials?|secret|api[_-]?key)/i.test(key)) continue;
        output[key] = sanitize(item, depth + 1, seen);
      }
      return output;
    };
    const cleaned = sanitize(event || {});
    const sanitized = cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)
      ? cleaned
      : { message: String(cleaned ?? '') };
    sanitized.occurredAt = sanitized.occurredAt || new Date().toISOString();

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
    if (this.flushPromise) return this.flushPromise;
    if (!this.eventQueue.length) return;
    this.flushPromise = this._flushEventQueue().finally(() => {
      this.flushPromise = null;
      if (this.eventQueue.length) {
        const delay = Math.max(100, Math.min(...this.eventQueue.map((item) => Math.max(0, item.nextRetryAt - Date.now()))));
        this.scheduleFlush(delay);
      }
    });
    return this.flushPromise;
  }

  async _flushEventQueue() {
    const batch = this.eventQueue;
    this.eventQueue = [];
    const now = Date.now();
    const remaining = [];
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/events`;

    for (const item of batch) {
      if (this.stopping) break;
      if (now < item.nextRetryAt) {
        remaining.push(item);
        continue;
      }

      try {
        await this.post(path, item.event);
      } catch (err) {
        // Discard permanent 4xx (except 429) errors without retrying forever
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          this.logger?.warn?.('manager_event_delivery_rejected_permanent', {
            workerId: this.workerId,
            status: err.status,
            error: err.message
          });
          continue;
        }
        item.attempts += 1;
        if (item.attempts >= 10) {
          this.logger?.warn?.('manager_event_delivery_exhausted', {
            workerId: this.workerId,
            attempts: item.attempts,
            error: err.message
          });
          continue;
        }
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

    this.eventQueue = [...remaining, ...this.eventQueue].slice(-100);
  }

  async sendEvent(event) {
    this.enqueueEvent(event);
    return this.flushEventQueue();
  }

  stop() {
    this.stopping = true;
    if (this.eventFlushTimer) {
      clearTimeout(this.eventFlushTimer);
      this.eventFlushTimer = null;
    }
  }
}

module.exports = ManagerReporter;
