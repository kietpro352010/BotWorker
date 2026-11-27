'use strict';

const { redactAuditValue } = require('../game/server-auth');
const { computeBotStateDigest } = require('../domain/worker-state');
const { ManagerUrlPool, shouldFailoverResponse } = require('./manager-urls');
const { resolveWorkerFetch } = require('./http-client');

const COALESCEABLE_TYPES = new Set([
  'connection_error',
  'connecting',
  'window_open',
  'window_close',
  'window_click'
]);
const EVENT_COALESCE_WINDOW_MS = 15000;
const MAX_EVENT_REPEAT_COUNT = 1000;

class ManagerReporter {
  constructor({ baseUrl, managerUrls = null, cacheFilePath = undefined, urlPool = null, workerId, secret = '', fetchImpl = undefined, logger, onSettingsChanged = null }) {
    this.cacheFilePath = cacheFilePath;
    this.urlPool = urlPool || new ManagerUrlPool({ baseUrl, managerUrls, cacheFilePath });
    this.workerId = workerId;
    this.secret = String(secret || '').trim();
    this.fetch = resolveWorkerFetch(fetchImpl);
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

  get baseUrl() {
    return this.urlPool.currentUrl();
  }

  set baseUrl(nextUrl) {
    if (nextUrl) {
      this.urlPool.setPrimary(nextUrl);
    }
  }

  learnManagerUrls(rawUrls) {
    return this.urlPool.learn(rawUrls);
  }

  getManagerUrls() {
    return this.urlPool.getUrlsOrdered();
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
    const candidates = this.urlPool.getUrlsOrdered();
    if (!candidates.length || !this.fetch || this.stopping) return;
    const startedAt = Date.now();
    let lastError = null;
    const urlsSig = typeof this.urlPool?.urlsSignature === 'function' ? this.urlPool.urlsSignature() : '';
    const headers = {
      'content-type': 'application/json',
      ...(this.secret ? { 'x-worker-secret': this.secret } : {}),
      'x-manager-bot-id': String(this.workerId),
      ...(urlsSig ? { 'x-manager-urls-sig': urlsSig } : {})
    };
    const bodyJson = JSON.stringify(payload);

    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const hasMore = i < candidates.length - 1;
      const timeoutSignal = AbortSignal.timeout(8000);
      const signals = [timeoutSignal, this.stopController.signal];
      if (signal) signals.push(signal);
      const combinedSignal = AbortSignal.any(signals);
      try {
        const response = await this.fetch(`${candidate}${path}`, {
          method: 'POST',
          headers,
          body: bodyJson,
          signal: combinedSignal
        });
        const body = await response.json().catch(async () => {
          await response.body?.cancel?.().catch(() => {});
          return {};
        });
        if (!response.ok || (body && typeof body.ok === 'boolean' && !body.ok)) {
          const err = new Error(body?.error || `manager_http_${response.status}`);
          err.status = response.status;
          if (shouldFailoverResponse(response, body)) {
            this.urlPool.markFailed?.(candidate);
            if (hasMore) {
              lastError = err;
              this.logger?.warn?.('manager_failover_retry', { workerId: this.workerId, failedUrl: candidate, status: response.status, error: err.message });
              continue;
            }
          }
          throw err;
        }
        this.urlPool.markHealthy(candidate);
        this.urlPool.learnFromResponse(response, body);
        this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
        return body;
      } catch (err) {
        if (this.stopping || signal?.aborted || this.stopController.signal.aborted) throw err;
        if (!err?.status || shouldFailoverResponse({ status: err.status }, null)) {
          this.urlPool.markFailed?.(candidate);
          if (hasMore) {
            lastError = err;
            this.logger?.warn?.('manager_failover_retry', { workerId: this.workerId, failedUrl: candidate, error: err?.message || String(err) });
            continue;
          }
        }
        throw err;
      }
    }
    throw lastError || new Error('manager_unreachable');
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

    const optNum = (key, val) => (val !== null && val !== undefined && Number.isFinite(Number(val)) ? { [key]: val } : {});
    const netDownKb = Number(raw.bandwidthRxBps) > 0 ? Math.round((Number(raw.bandwidthRxBps) / 1024) * 10) / 10 : 0;
    const netUpKb = Number(raw.bandwidthTxBps) > 0 ? Math.round((Number(raw.bandwidthTxBps) / 1024) * 10) / 10 : 0;
    const payload = digestUnchanged
      ? {
          workerId: raw.workerId,
          transport: raw.transport,
          state: raw.state,
          connected: Boolean(raw.connected),
          online: Boolean(raw.online ?? raw.connected),
          ...(raw.manuallyStopped !== undefined ? { manuallyStopped: Boolean(raw.manuallyStopped) } : {}),
          ...optNum('managerLatencyMs', this.managerLatencyMs),
          stateDigest: digest,
          digestUnchanged: true,
          isLightweight: true,
          ...optNum('uptimeSeconds', raw.uptimeSeconds),
          ...optNum('pingMs', raw.pingMs),
          ...optNum('tps', raw.tps),
          ...optNum('cpuPercent', raw.cpuPercent),
          ...optNum('rssMb', raw.rssMb),
          ...optNum('heapUsedMb', raw.heapUsedMb),
          ...(netDownKb > 0 ? { netDownKb } : {}),
          ...(netUpKb > 0 ? { netUpKb } : {}),
          ...(raw.lastStateAt !== undefined ? { lastStateAt: raw.lastStateAt } : {}),
          ...(positionMoved ? { position: raw.position } : { positionUnchanged: true })
        }
      : {
          ...raw,
          netDownKb,
          netUpKb,
          ...optNum('managerLatencyMs', this.managerLatencyMs),
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
    const candidates = this.urlPool.getUrlsOrdered();
    const urlsSig = typeof this.urlPool?.urlsSignature === 'function' ? this.urlPool.urlsSignature() : '';
    const headers = {
      ...(this.secret ? { 'x-worker-secret': this.secret } : {}),
      'x-manager-bot-id': String(this.workerId),
      ...(urlsSig ? { 'x-manager-urls-sig': urlsSig } : {})
    };
    let lastError = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const hasMore = i < candidates.length - 1;
      const timeoutSignal = AbortSignal.timeout(8000);
      const signals = [timeoutSignal, this.stopController.signal];
      if (signal) signals.push(signal);
      const combinedSignal = AbortSignal.any(signals);
      try {
        const response = await this.fetch(`${candidate}${path}`, {
          headers,
          signal: combinedSignal
        });
        const body = await response.json().catch(async () => {
          await response.body?.cancel?.().catch(() => {});
          return {};
        });
        if (!response.ok || !body.ok) {
          const err = new Error(body?.error || `manager_http_${response.status}`);
          err.status = response.status;
          if (shouldFailoverResponse(response, body)) {
            this.urlPool.markFailed?.(candidate);
            if (hasMore) {
              lastError = err;
              this.logger?.warn?.('manager_bootstrap_failover_retry', { workerId: this.workerId, failedUrl: candidate, status: response.status, error: err.message });
              continue;
            }
          }
          throw err;
        }
        this.urlPool.markHealthy(candidate);
        this.urlPool.learnFromResponse(response, body);
        this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
        if (body.settingsRevision !== undefined) {
          this.lastSettingsRevision = body.settingsRevision;
        }
        return body;
      } catch (err) {
        if (this.stopping || signal?.aborted || this.stopController.signal.aborted) throw err;
        if (!err?.status || shouldFailoverResponse({ status: err.status }, null)) {
          this.urlPool.markFailed?.(candidate);
          if (hasMore) {
            lastError = err;
            this.logger?.warn?.('manager_bootstrap_failover_retry', { workerId: this.workerId, failedUrl: candidate, error: err?.message || String(err) });
            continue;
          }
        }
        throw err;
      }
    }
    throw lastError || new Error('manager_unreachable');
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
    const incomingRepeat = sanitized.repeatCount !== undefined
      ? Math.max(1, Math.min(MAX_EVENT_REPEAT_COUNT, Math.floor(Number(sanitized.repeatCount) || 1)))
      : 1;
    if (sanitized.repeatCount !== undefined) {
      sanitized.repeatCount = incomingRepeat;
    }

    const evType = typeof sanitized.type === 'string' ? sanitized.type.trim() : '';
    const evMsg = typeof sanitized.message === 'string' ? sanitized.message : '';
    if (COALESCEABLE_TYPES.has(evType) && this.eventQueue.length > 0) {
      const tailItem = this.eventQueue[this.eventQueue.length - 1];
      const last = tailItem?.event;
      if (last && last.type === evType && String(last.message || '') === evMsg) {
        const prevMs = Date.parse(last.occurredAt || '');
        const currMs = Date.parse(sanitized.occurredAt || '');
        if (
          Number.isFinite(prevMs) &&
          Number.isFinite(currMs) &&
          currMs >= prevMs - 1000 &&
          (currMs - prevMs) <= EVENT_COALESCE_WINDOW_MS
        ) {
          last.firstOccurredAt = last.firstOccurredAt || last.occurredAt || sanitized.occurredAt;
          last.occurredAt = sanitized.occurredAt;
          last.repeatCount = Math.min(MAX_EVENT_REPEAT_COUNT, (Number(last.repeatCount) || 1) + incomingRepeat);
          tailItem.coalescedDirty = true;
          if (!this.stopping) {
            this.scheduleFlush(0);
          }
          return;
        }
      }
    }

    if (this.eventQueue.length >= 100) {
      this.eventQueue.shift(); // Bound queue to prevent memory leak
    }

    this.eventQueue.push({
      event: sanitized,
      attempts: 0,
      nextRetryAt: 0,
      coalescedDirty: false
    });

    if (!this.stopping) {
      const isLowPriorityChat = evType === 'chat' || evType === 'message';
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

  async flushEvents() {
    return this.flushEventQueue();
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

  _mergeQueues(olderItems = [], newerItems = []) {
    const merged = [];
    const append = (item) => {
      if (!item || !item.event) return;
      const ev = item.event;
      const evType = typeof ev.type === 'string' ? ev.type.trim() : '';
      const evMsg = typeof ev.message === 'string' ? ev.message : '';
      if (COALESCEABLE_TYPES.has(evType) && merged.length > 0) {
        const tail = merged[merged.length - 1];
        const prev = tail?.event;
        if (prev && prev.type === evType && String(prev.message || '') === evMsg) {
          const prevMs = Date.parse(prev.occurredAt || '');
          const currMs = Date.parse(ev.occurredAt || '');
          if (
            Number.isFinite(prevMs) &&
            Number.isFinite(currMs) &&
            currMs >= prevMs - 1000 &&
            (currMs - prevMs) <= EVENT_COALESCE_WINDOW_MS
          ) {
            prev.firstOccurredAt = prev.firstOccurredAt || prev.occurredAt || ev.firstOccurredAt || ev.occurredAt;
            prev.occurredAt = ev.occurredAt || prev.occurredAt;
            const addCount = Math.max(1, Math.min(MAX_EVENT_REPEAT_COUNT, Math.floor(Number(ev.repeatCount) || 1)));
            prev.repeatCount = Math.min(MAX_EVENT_REPEAT_COUNT, (Number(prev.repeatCount) || 1) + addCount);
            tail.coalescedDirty = true;
            return;
          }
        }
      }
      merged.push(item);
    };
    for (let i = 0; i < olderItems.length; i++) append(olderItems[i]);
    for (let i = 0; i < newerItems.length; i++) append(newerItems[i]);
    return merged.length > 100 ? merged.slice(-100) : merged;
  }

  async _flushEventQueue() {
    const batch = this.eventQueue;
    this.eventQueue = [];
    const now = Date.now();
    const notReady = [];
    const ready = [];
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/events`;

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (this.stopping) {
        this.eventQueue = this._mergeQueues([...notReady, ...ready, ...batch.slice(i)], this.eventQueue);
        return;
      }
      if (now < item.nextRetryAt) {
        notReady.push(item);
      } else {
        ready.push(item);
      }
    }

    if (!ready.length) {
      this.eventQueue = this._mergeQueues(notReady, this.eventQueue);
      return;
    }

    // Fast path: coalesce multiple ready events into one HTTP POST when >= 2 events are ready
    if (ready.length >= 2 && !this.stopping && this._batchEventsUnsupported !== true) {
      try {
        await this.post(path, { events: ready.map((item) => item.event) });
        for (let r = 0; r < ready.length; r++) ready[r].coalescedDirty = false;
        this.eventQueue = this._mergeQueues(notReady, this.eventQueue);
        return;
      } catch (batchErr) {
        // If server/mock rejects batch envelope with 400/422, mark unsupported and fall through to per-item delivery
        if (batchErr?.status === 400 || batchErr?.status === 422) {
          this._batchEventsUnsupported = true;
        } else {
          // Transient failure: apply standard retry/permanent-4xx handling preserving chronological order
          if (this.stopping) {
            this.eventQueue = this._mergeQueues(batch, this.eventQueue);
            return;
          }
          if (batchErr.status && batchErr.status >= 400 && batchErr.status < 500 && batchErr.status !== 429) {
            this.logger?.warn?.('manager_event_delivery_rejected_permanent', {
              workerId: this.workerId,
              status: batchErr.status,
              error: batchErr.message
            });
            this.eventQueue = this._mergeQueues(notReady, this.eventQueue);
            return;
          }
          const exhausted = new Set();
          for (const item of ready) {
            item.attempts += 1;
            if (item.attempts >= 10) {
              exhausted.add(item);
              this.logger?.warn?.('manager_event_delivery_exhausted', {
                workerId: this.workerId,
                attempts: item.attempts,
                error: batchErr.message
              });
              continue;
            }
            const backoffMs = Math.min(60000, 1000 * Math.pow(2, Math.min(item.attempts, 5)));
            item.nextRetryAt = Date.now() + backoffMs;
          }
          this.logger?.warn?.('manager_event_delivery_retry', {
            workerId: this.workerId,
            batchSize: ready.length,
            error: batchErr.message
          });
          const surviving = exhausted.size ? batch.filter((it) => !exhausted.has(it)) : batch;
          this.eventQueue = this._mergeQueues(surviving, this.eventQueue);
          return;
        }
      }
    }

    const settledItems = new Set();
    for (let i = 0; i < ready.length; i++) {
      const item = ready[i];
      if (this.stopping) {
        break;
      }

      try {
        await this.post(path, item.event);
        item.coalescedDirty = false;
        settledItems.add(item);
      } catch (err) {
        if (this.stopping) {
          break;
        }
        // Discard permanent 4xx (except 429) errors without retrying forever
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          settledItems.add(item);
          this.logger?.warn?.('manager_event_delivery_rejected_permanent', {
            workerId: this.workerId,
            status: err.status,
            error: err.message
          });
          continue;
        }
        item.attempts += 1;
        if (item.attempts >= 10) {
          settledItems.add(item);
          this.logger?.warn?.('manager_event_delivery_exhausted', {
            workerId: this.workerId,
            attempts: item.attempts,
            error: err.message
          });
          continue;
        }
        const backoffMs = Math.min(60000, 1000 * Math.pow(2, Math.min(item.attempts, 5)));
        item.nextRetryAt = Date.now() + backoffMs;
        this.logger?.warn?.('manager_event_delivery_retry', {
          workerId: this.workerId,
          attempts: item.attempts,
          nextRetryInMs: backoffMs,
          error: err.message
        });
      }
    }

    const unsentInOrder = settledItems.size ? batch.filter((it) => !settledItems.has(it)) : batch;
    this.eventQueue = this._mergeQueues(unsentInOrder, this.eventQueue);
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
    const hadEvents = this.eventQueue.length > 0 || Boolean(this.flushPromise);
    if (!hadEvents && !finalStatus) {
      return { flushedEvents: false, sentFinalStatus: false };
    }
    if (this.eventFlushTimer) {
      clearTimeout(this.eventFlushTimer);
      this.eventFlushTimer = null;
    }
    const drainController = new AbortController();
    const timer = setTimeout(() => drainController.abort(), Math.max(100, timeoutMs));
    timer.unref?.();
    try {
      const drainEventsTask = async () => {
        if (!hadEvents || this.stopping) return;
        if (this.flushPromise) {
          await this.flushPromise.catch(() => {});
        }
        if (!this.stopping && !drainController.signal.aborted && this.eventQueue.length > 0) {
          for (const item of this.eventQueue) {
            if (item && typeof item === 'object') item.nextRetryAt = 0;
          }
          await this.flushEventQueue();
        }
      };
      const tasks = [];
      if (hadEvents && !this.stopping) {
        tasks.push(drainEventsTask());
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
      return { flushedEvents: hadEvents && this.eventQueue.length === 0 && !this.flushPromise, sentFinalStatus: Boolean(finalStatus) };
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

ManagerReporter.COALESCEABLE_TYPES = COALESCEABLE_TYPES;
ManagerReporter.EVENT_COALESCE_WINDOW_MS = EVENT_COALESCE_WINDOW_MS;
module.exports = ManagerReporter;
