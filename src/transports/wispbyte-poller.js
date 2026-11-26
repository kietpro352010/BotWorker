'use strict';

function cancellableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

class WispbytePoller {
  constructor({ config, runtime, reporter, logger, fetchImpl = global.fetch, authFailureThreshold = 5, authBackoffScheduleMs = [15000, 30000, 60000, 120000, 300000] }) {
    this.config = config;
    this.runtime = runtime;
    this.reporter = reporter;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.stopping = false;
    this.loopPromise = null;
    this.failures = 0;
    this.consecutiveAuthFailures = 0;
    this.authPaused = false;
    this.authStopPending = false;
    this.authFailureThreshold = Math.max(1, Number(authFailureThreshold) || 5);
    this.authBackoffScheduleMs = Array.isArray(authBackoffScheduleMs) && authBackoffScheduleMs.length
      ? authBackoffScheduleMs
      : [15000, 30000, 60000, 120000, 300000];
    this.activeController = null;
    this.activeControllers = new Set();
    this.stopController = new AbortController();
    this.pendingResults = [];
    this.maxPendingResults = 100;
    this.resultFlushPromise = null;
    this._unchangedLightPollCount = 0;
    this._lastTelemetryPollSentAt = 0;
  }

  start() {
    if (this.loopPromise) return this.loopPromise;
    this.stopping = false;
    this.consecutiveAuthFailures = 0;
    this.authPaused = false;
    this.authStopPending = false;
    this._unchangedLightPollCount = 0;
    this._lastTelemetryPollSentAt = 0;
    this.stopController = new AbortController();
    this.loopPromise = this.run().finally(() => { this.loopPromise = null; });
    return this.loopPromise;
  }

  async _handleAuthFailure(status) {
    this.consecutiveAuthFailures += 1;
    const idx = Math.min(this.consecutiveAuthFailures - 1, this.authBackoffScheduleMs.length - 1);
    const delayMs = this.authBackoffScheduleMs[idx] || 300000;
    this.logger?.warn?.('worker_auth_check_failed', {
      status,
      consecutiveAuthFailures: this.consecutiveAuthFailures,
      threshold: this.authFailureThreshold,
      retryInMs: delayMs
    });
    if (this.consecutiveAuthFailures >= this.authFailureThreshold) {
      if (!this.authPaused) {
        this.authPaused = true;
        this.authStopPending = true;
        this.logger?.error?.('worker_registration_lost', {
          status,
          consecutiveAuthFailures: this.consecutiveAuthFailures
        });
      }
      if (this.authStopPending && typeof this.runtime?.execute === 'function') {
        try {
          await this.runtime.execute('stop');
          this.authStopPending = false;
        } catch (err) {
          if (err?.code === 'LIFECYCLE_CONFLICT' || /already in progress|conflicting/i.test(err?.message || '')) {
            this.authStopPending = true;
          } else {
            this.authStopPending = false;
          }
        }
      }
    }
    return delayMs;
  }

  enqueueResult(resultPayload) {
    if (this.pendingResults.length >= this.maxPendingResults) {
      this.pendingResults.shift(); // Drop oldest to prevent unbounded growth
    }
    this.pendingResults.push({
      payload: resultPayload,
      attempts: 0,
      nextRetryAt: 0
    });
  }

  async flushPendingResults() {
    if (this.resultFlushPromise) return this.resultFlushPromise;
    if (!this.pendingResults.length || this.stopping) return;
    this.resultFlushPromise = this._flushPendingResults().finally(() => {
      this.resultFlushPromise = null;
    });
    return this.resultFlushPromise;
  }

  async _flushPendingResults() {
    const batch = this.pendingResults;
    this.pendingResults = [];
    if (this.stopping) {
      this.pendingResults = [...batch, ...this.pendingResults].slice(-this.maxPendingResults);
      return;
    }
    const now = Date.now();
    const remaining = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (this.stopping) {
        remaining.push(...batch.slice(i));
        break;
      }
      if (now < item.nextRetryAt) {
        remaining.push(item);
        continue;
      }
      try {
        await this.request(`/api/v1/workers/${encodeURIComponent(this.config.workerId)}/result`, item.payload);
      } catch (err) {
        if (this.stopping) {
          remaining.push(...batch.slice(i));
          break;
        }
        if ([401, 404].includes(err.status)) {
          const authDelayMs = await this._handleAuthFailure(err.status);
          this._lastFlushAuthDelayMs = authDelayMs;
          remaining.push(...batch.slice(i));
          break;
        }
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          this.logger?.warn?.('wispbyte_result_rejected_permanent', {
            commandId: item.payload?.commandId,
            status: err.status,
            error: err.message
          });
          continue;
        }
        item.attempts += 1;
        if (item.attempts >= 10) {
          this.logger?.warn?.('wispbyte_result_retries_exhausted', {
            commandId: item.payload?.commandId,
            attempts: item.attempts,
            error: err.message
          });
          continue;
        }
        const backoffMs = Math.min(60000, 1000 * Math.pow(2, Math.min(item.attempts, 6)));
        item.nextRetryAt = Date.now() + backoffMs;
        remaining.push(item);
        this.logger?.warn?.('wispbyte_result_retry_failed', {
          commandId: item.payload?.commandId,
          attempts: item.attempts,
          nextRetryInMs: backoffMs,
          error: err.message
        });
      }
    }
    this.pendingResults = [...remaining, ...this.pendingResults].slice(-this.maxPendingResults);
  }

  async request(path, payload, { timeoutMs = 35000 } = {}) {
    const baseUrl = this.config.managerUrl || this.config.managerBaseUrl || '';
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 35000));
    timeout.unref?.();
    this.activeController = controller;
    this.activeControllers.add(controller);
    try {
      const combinedSignal = AbortSignal.any([controller.signal, this.stopController.signal]);
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-worker-secret': this.config.secret,
          'x-manager-bot-id': String(this.config.workerId)
        },
        body: JSON.stringify(payload), signal: combinedSignal
      });
      const body = await response.json().catch(async () => {
        await response.body?.cancel?.().catch(() => {});
        return {};
      });
      if (!response.ok || !body.ok) {
        const error = new Error(body.error || `manager_http_${response.status}`);
        error.status = response.status;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  async run() {
    while (!this.stopping) {
      try {
        this._lastFlushAuthDelayMs = 0;
        await this.flushPendingResults();
        if (this._lastFlushAuthDelayMs > 0) {
          const authWaitMs = this._lastFlushAuthDelayMs;
          this._lastFlushAuthDelayMs = 0;
          await cancellableSleep(authWaitMs, this.stopController.signal);
          continue;
        }
        const rawStatus = this.runtime.status();
        const prepared = (this.reporter && typeof this.reporter.prepareStatusPayload === 'function')
          ? this.reporter.prepareStatusPayload(rawStatus)
          : { payload: { ...rawStatus, managerLatencyMs: this.reporter?.managerLatencyMs } };
        const waitMs = Math.max(1000, Math.min(55000, Number(this.config?.pollWaitMs) || 45000));
        const nowPollMs = Date.now();
        const canOmitSteadyTelemetry = Boolean(
          prepared.digestUnchanged === true &&
          !prepared.positionMoved &&
          this._unchangedLightPollCount >= 1 &&
          this._lastTelemetryPollSentAt > 0 &&
          (nowPollMs - this._lastTelemetryPollSentAt < 120000)
        );
        const pollBody = canOmitSteadyTelemetry
          ? { waitMs }
          : { status: prepared.payload, waitMs, sentAt: new Date(nowPollMs).toISOString() };
        const response = await this.request(
          `/api/v1/workers/${encodeURIComponent(this.config.workerId)}/poll`,
          pollBody,
          { timeoutMs: Math.max(35000, waitMs + 12000) }
        );
        if (!canOmitSteadyTelemetry) {
          this._lastTelemetryPollSentAt = Date.now();
          if (prepared.digestUnchanged === true && !prepared.positionMoved) {
            this._unchangedLightPollCount += 1;
          } else {
            this._unchangedLightPollCount = 0;
          }
          this.reporter?.recordStatusSent?.(prepared);
        } else if (prepared.digestUnchanged !== true || prepared.positionMoved) {
          this._unchangedLightPollCount = 0;
        }
        if (response && response.settingsRevision !== undefined) {
          const prevSettingsRev = this.reporter?.lastSettingsRevision;
          this.reporter?.noteSettingsRevision?.(response.settingsRevision);
          if (prevSettingsRev !== null && prevSettingsRev !== undefined && prevSettingsRev !== response.settingsRevision) {
            this._unchangedLightPollCount = 0;
          }
        }
        this.failures = 0;
        if (this.consecutiveAuthFailures > 0 || this.authPaused) {
          this.logger?.info?.('worker_auth_recovered', { previousAuthFailures: this.consecutiveAuthFailures });
          this.consecutiveAuthFailures = 0;
          this.authPaused = false;
          this.authStopPending = false;
        }
        if (response.command?.action) {
          const command = response.command;
          let result;
          if (command.expiresAt && Date.parse(command.expiresAt) <= Date.now()) {
            result = { ok: false, error: 'command_expired' };
          } else {
            const rawPayload = (command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload))
              ? { ...command.payload }
              : {};
            delete rawPayload.timeoutMs;
            delete rawPayload.execTimeoutMs;
            delete rawPayload.queueTimeoutMs;
            try { result = await this.runtime.execute(command.action, rawPayload, { signal: this.stopController.signal }); }
            catch (error) { result = { ok: false, error: error.message, code: error.code || null, status: error.status || null }; }
          }
          const resultPayload = {
            commandId: command.commandId,
            action: command.action,
            result,
            completedAt: new Date().toISOString()
          };
          let authDelayMs = 0;
          try {
            await this.request(`/api/v1/workers/${encodeURIComponent(this.config.workerId)}/result`, resultPayload);
          } catch (err) {
            if ([401, 404].includes(err.status)) {
              authDelayMs = await this._handleAuthFailure(err.status);
            }
            this.logger?.warn?.('wispbyte_result_send_failed_queueing', {
              commandId: command.commandId,
              error: err.message
            });
            this.enqueueResult(resultPayload);
          }
          await cancellableSleep(authDelayMs > 0 ? authDelayMs : 500, this.stopController.signal);
        } else {
          // Adaptive polling interval: 1.5s when transitioning, 8-12s when online/afk, 12-18s when stopped/inactive
          const stateStr = String(prepared.payload?.state || '').toLowerCase();
          const isIdle = ['idle', 'stopped', 'disconnected', 'error', 'afk', 'afk_locked', 'online', 'maintenance', 'ip_limited', 'banned'].includes(stateStr);
          const isInactive = ['idle', 'stopped', 'disconnected', 'maintenance', 'ip_limited', 'banned'].includes(stateStr);
          const adaptiveDelayMs = isInactive
            ? (12000 + Math.floor(Math.random() * 6000))
            : (isIdle ? (8000 + Math.floor(Math.random() * 4000)) : 1500);
          await cancellableSleep(adaptiveDelayMs, this.stopController.signal);
        }
      } catch (error) {
        if (this.stopping) break;
        if ([401, 404].includes(error.status)) {
          const authDelayMs = await this._handleAuthFailure(error.status);
          await cancellableSleep(authDelayMs, this.stopController.signal);
          continue;
        }
        this.failures += 1;
        this.logger.warn('wispbyte_poll_failed', { failures: this.failures, error: error.message });
        const delay = Math.min(60000, 1500 * (2 ** Math.min(this.failures, 5))) + Math.floor(Math.random() * 1000);
        await cancellableSleep(delay, this.stopController.signal);
      }
    }
  }

  async drainPendingResults({ timeoutMs = 2000 } = {}) {
    if (!this.pendingResults.length) return 0;
    const prevStopping = this.stopping;
    this.stopping = false;
    for (const item of this.pendingResults) {
      if (item && typeof item === 'object') item.nextRetryAt = 0;
    }
    let timer = null;
    try {
      const initialCount = this.pendingResults.length;
      await Promise.race([
        this.flushPendingResults(),
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.max(100, timeoutMs));
          timer.unref?.();
        })
      ]);
      return Math.max(0, initialCount - this.pendingResults.length);
    } catch (_) {
      return 0;
    } finally {
      if (timer) clearTimeout(timer);
      this.stopping = prevStopping;
    }
  }

  async stop() {
    this.stopping = true;
    this.stopController?.abort();
    this.activeController?.abort();
    for (const c of this.activeControllers) {
      try { c.abort(); } catch (_) {}
    }
    this.activeControllers.clear();
    await this.loopPromise?.catch(() => {});
  }
}

module.exports = WispbytePoller;

