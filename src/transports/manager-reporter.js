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
    this.settingsRefreshInFlight = false;
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
    this.stopController = new AbortController();
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
    const signals = [timeoutSignal, this.stopController.signal];
    if (signal) signals.push(signal);
    const combinedSignal = AbortSignal.any(signals);
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
    const body = await response.json().catch(async () => {
      await response.body?.cancel?.().catch(() => {});
      return {};
    });
    if (!response.ok || (body && typeof body.ok === 'boolean' && !body.ok)) {
      const err = new Error(body?.error || `manager_http_${response.status}`);
      err.status = response.status;
      throw err;
    }
    this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
    return body;
  }

  async heartbeat(status) {
    this.pendingHeartbeat = status;
    if (this.heartbeatPromise) return this.heartbeatPromise;

    this.heartbeatPromise = this.flushHeartbeats().finally(() => {
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

  async flushHeartbeats() {
    while (this.pendingHeartbeat && !this.stopping) {
      const status = this.pendingHeartbeat;
      this.pendingHeartbeat = null;
      await this.sendHeartbeat(status, { signal: this.stopController.signal });
    }
  }

  prepareStatusPayload(status) {
    const now = Date.now();
    const raw = status && typeof status === 'object' ? status : {};
    const seq = ++this.statusSeq;
    const digest = computeBotStateDigest(raw);
    const digestUnchanged = this.lastStateDigest === digest && (now - this.lastFullReportAt < 300000);
    const stateStr = String(raw.state || '').toLowerCase();
    const disconnected = raw.connected === false || !raw.position
      || ['stopped', 'disconnected', 'error', 'maintenance', 'ip_limited', 'banned'].includes(stateStr);
    const positionMoved = Boolean(!disconnected && raw.position && this.hasPositionMovedSignificantly(raw.position));

    const payload = digestUnchanged
      ? {
          workerId: raw.workerId,
          transport: raw.transport,
          state: raw.state,
          connected: Boolean(raw.connected),
          online: Boolean(raw.online ?? raw.connected),
          ...(raw.manuallyStopped !== undefined ? { manuallyStopped: Boolean(raw.manuallyStopped) } : {}),
          managerLatencyMs: this.managerLatencyMs,
          stateDigest: digest,
          digestUnchanged: true,
          isLightweight: true,
          uptimeSeconds: raw.uptimeSeconds,
          pingMs: raw.pingMs,
          tps: raw.tps,
          cpuPercent: raw.cpuPercent,
          rssMb: raw.rssMb,
          heapUsedMb: raw.heapUsedMb,
          ...(raw.lastStateAt !== undefined ? { lastStateAt: raw.lastStateAt } : {}),
          ...(positionMoved ? { position: raw.position } : { positionUnchanged: true })
        }
      : {
          ...raw,
          managerLatencyMs: this.managerLatencyMs,
          stateDigest: digest,
          digestUnchanged: false,
          ...(raw.position && !positionMoved ? { positionUnchanged: true } : {})
        };

    return { seq, payload, digest, digestUnchanged, disconnected, positionMoved, position: raw.position || null };
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
    if (meta.disconnected) {
      this.lastReportedPosition = null;
    } else if (meta.positionMoved && meta.position) {
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
    if (!response) return response;
    this.recordStatusSent(meta);
    if (response.settingsRevision !== undefined) {
      this.noteSettingsRevision(response.settingsRevision);
    }
    return response;
  }

  noteSettingsRevision(rev) {
    if (rev === undefined || rev === null) return;
    const prev = this.lastSettingsRevision;
    if (prev === null) {
      this.lastSettingsRevision = rev;
      return;
    }
    if (prev === rev) return;
    if (this.stopping) return;
    if (!this.onSettingsChanged) {
      this.lastSettingsRevision = rev;
      return;
    }
    if (this.settingsRefreshInFlight) return;
    this.settingsRefreshInFlight = true;
    void Promise.resolve()
      .then(() => this.onSettingsChanged(rev))
      .then(() => {
        if (this.lastSettingsRevision === prev) {
          this.lastSettingsRevision = rev;
        }
      })
      .catch((err) => {
        this.logger?.debug?.('manager_settings_revision_refresh_retry_pending', {
          workerId: this.workerId,
          previousRevision: prev,
          targetRevision: rev,
          error: err?.message || 'refresh_failed'
        });
      })
      .finally(() => {
        this.settingsRefreshInFlight = false;
      });
  }

  async bootstrap({ signal } = {}) {
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/bootstrap`;
    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(8000);
    const signals = [timeoutSignal, this.stopController.signal];
    if (signal) signals.push(signal);
    const combinedSignal = AbortSignal.any(signals);
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
      try {
        if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1, seen));
        const output = {};
        for (const [key, item] of Object.entries(value)) {
          if (/(?:password|token|authorization|credentials?|secret|api[_-]?key)/i.test(key)) continue;
          output[key] = sanitize(item, depth + 1, seen);
        }
        return output;
      } finally {
        seen.delete(value);
      }
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

    if (!this.stopping) {
      const isLowPriorityChat = sanitized.type === 'chat' || sanitized.type === 'message';
      this.scheduleFlush(isLowPriorityChat ? 250 : 0);
    }
  }

  scheduleFlush(delayMs = 1000) {
    if (this.stopping || this.eventFlushTimer) return;
    this.eventFlushTimer = setTimeout(() => {
      this.eventFlushTimer = null;
      if (this.stopping) return;
      void this.flushEventQueue();
    }, delayMs);
    this.eventFlushTimer.unref?.();
  }

  async flushEventQueue() {
    if (this.flushPromise) return this.flushPromise;
    if (this.stopping || !this.eventQueue.length) return;
    this.flushPromise = this._flushEventQueue().finally(() => {
      this.flushPromise = null;
      if (!this.stopping && this.eventQueue.length) {
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
    const ready = [];
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/events`;

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (this.stopping) {
        remaining.push(...batch.slice(i));
        break;
      }
      if (now < item.nextRetryAt) {
        remaining.push(item);
      } else {
        ready.push(item);
      }
    }

    // Fast path: coalesce multiple ready events into one HTTP POST when >= 2 events are ready
    if (ready.length >= 2 && !this.stopping && this._batchEventsUnsupported !== true) {
      try {
        await this.post(path, { events: ready.map((item) => item.event) });
        this.eventQueue = [...remaining, ...this.eventQueue].slice(-100);
        return;
      } catch (batchErr) {
        // If server/mock rejects batch envelope with 400/422, mark unsupported and fall through to per-item delivery
        if (batchErr?.status === 400 || batchErr?.status === 422) {
          this._batchEventsUnsupported = true;
        } else {
          // Transient failure: apply standard retry/permanent-4xx handling to ready items
          if (this.stopping) {
            this.eventQueue = [...ready, ...remaining, ...this.eventQueue].slice(-100);
            return;
          }
          if (batchErr.status && batchErr.status >= 400 && batchErr.status < 500 && batchErr.status !== 429) {
            this.logger?.warn?.('manager_event_delivery_rejected_permanent', {
              workerId: this.workerId,
              status: batchErr.status,
              error: batchErr.message
            });
            this.eventQueue = [...remaining, ...this.eventQueue].slice(-100);
            return;
          }
          for (const item of ready) {
            item.attempts += 1;
            if (item.attempts >= 10) {
              this.logger?.warn?.('manager_event_delivery_exhausted', {
                workerId: this.workerId,
                attempts: item.attempts,
                error: batchErr.message
              });
              continue;
            }
            const backoffMs = Math.min(60000, 1000 * Math.pow(2, Math.min(item.attempts, 5)));
            item.nextRetryAt = Date.now() + backoffMs;
            remaining.push(item);
          }
          this.logger?.warn?.('manager_event_delivery_retry', {
            workerId: this.workerId,
            batchSize: ready.length,
            error: batchErr.message
          });
          this.eventQueue = [...remaining, ...this.eventQueue].slice(-100);
          return;
        }
      }
    }

    for (let i = 0; i < ready.length; i++) {
      const item = ready[i];
      if (this.stopping) {
        remaining.push(...ready.slice(i));
        break;
      }

      try {
        await this.post(path, item.event);
      } catch (err) {
        if (this.stopping) {
          remaining.push(...ready.slice(i));
          break;
        }
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

  reset() {
    this.stopping = false;
    this.stopController = new AbortController();
    this.lastReportedPosition = null;
  }

  async drain({ finalStatus = null, timeoutMs = 2000 } = {}) {
    const hasEvents = this.eventQueue.length > 0;
    if (!hasEvents && !finalStatus) {
      return { flushedEvents: false, sentFinalStatus: false };
    }
    if (this.eventFlushTimer) {
      clearTimeout(this.eventFlushTimer);
      this.eventFlushTimer = null;
    }
    for (const item of this.eventQueue) {
      if (item && typeof item === 'object') item.nextRetryAt = 0;
    }
    const drainController = new AbortController();
    const timer = setTimeout(() => drainController.abort(), Math.max(100, timeoutMs));
    timer.unref?.();
    try {
      const tasks = [];
      if (hasEvents && !this.stopping) {
        tasks.push(this.flushEventQueue());
      }
      if (finalStatus && !this.stopping) {
        tasks.push(this.sendHeartbeat(finalStatus, { signal: drainController.signal }));
      }
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise((resolve) => {
          drainController.signal.addEventListener('abort', resolve, { once: true });
        })
      ]);
      return { flushedEvents: hasEvents && this.eventQueue.length === 0, sentFinalStatus: Boolean(finalStatus) };
    } catch (_) {
      return { flushedEvents: false, sentFinalStatus: false };
    } finally {
      clearTimeout(timer);
    }
  }

  stop() {
    this.stopping = true;
    this.pendingHeartbeat = null;
    try { this.stopController.abort(); } catch (_) {}
    if (this.eventFlushTimer) {
      clearTimeout(this.eventFlushTimer);
      this.eventFlushTimer = null;
    }
  }
}

module.exports = ManagerReporter;
