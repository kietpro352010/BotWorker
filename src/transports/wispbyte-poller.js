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
  constructor({ config, runtime, reporter, logger, fetchImpl = global.fetch }) {
    this.config = config;
    this.runtime = runtime;
    this.reporter = reporter;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.stopping = false;
    this.loopPromise = null;
    this.failures = 0;
    this.activeController = null;
    this.stopController = new AbortController();
    this.pendingResults = [];
    this.maxPendingResults = 100;
    this.resultFlushPromise = null;
  }

  start() {
    if (this.loopPromise) return this.loopPromise;
    this.stopping = false;
    this.stopController = new AbortController();
    this.loopPromise = this.run().finally(() => { this.loopPromise = null; });
    return this.loopPromise;
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
    for (const item of batch) {
      if (now < item.nextRetryAt) {
        remaining.push(item);
        continue;
      }
      try {
        await this.request(`/api/v1/workers/${encodeURIComponent(this.config.workerId)}/result`, item.payload);
      } catch (err) {
        item.attempts += 1;
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

  async request(path, payload) {
    const baseUrl = this.config.managerUrl || this.config.managerBaseUrl || '';
    const url = `${baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    this.activeController = controller;
    try {
      const response = await this.fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': this.config.secret },
        body: JSON.stringify(payload), signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        const error = new Error(body.error || `manager_http_${response.status}`);
        error.status = response.status;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timeout);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  async run() {
    while (!this.stopping) {
      try {
        await this.flushPendingResults();
        const current = { ...this.runtime.status(), managerLatencyMs: this.reporter.managerLatencyMs };
        const response = await this.request(`/api/v1/workers/${encodeURIComponent(this.config.workerId)}/poll`, {
          status: current, waitMs: 25000, sentAt: new Date().toISOString()
        });
        this.failures = 0;
        if (response.command?.action) {
          const command = response.command;
          let result;
          if (command.expiresAt && Date.parse(command.expiresAt) <= Date.now()) {
            result = { ok: false, error: 'command_expired' };
          } else {
            try { result = await this.runtime.execute(command.action, command.payload || {}); }
            catch (error) { result = { ok: false, error: error.message, code: error.code || null, status: error.status || null }; }
          }
          const resultPayload = {
            commandId: command.commandId,
            action: command.action,
            result,
            completedAt: new Date().toISOString()
          };
          try {
            await this.request(`/api/v1/workers/${encodeURIComponent(this.config.workerId)}/result`, resultPayload);
          } catch (err) {
            this.logger?.warn?.('wispbyte_result_send_failed_queueing', {
              commandId: command.commandId,
              error: err.message
            });
            this.enqueueResult(resultPayload);
          }
          await cancellableSleep(500, this.stopController.signal);
        } else {
          // Adaptive polling interval: 1.5s when active/transitioning, 4s-6s when steady/idle
          const stateStr = String(current.state || '').toLowerCase();
          const isIdle = ['idle', 'stopped', 'disconnected', 'afk_locked', 'online', 'maintenance', 'ip_limited', 'banned'].includes(stateStr);
          const adaptiveDelayMs = isIdle ? (4000 + Math.floor(Math.random() * 2000)) : 1500;
          await cancellableSleep(adaptiveDelayMs, this.stopController.signal);
        }
      } catch (error) {
        if (this.stopping) break;
        if ([401, 404].includes(error.status)) {
          this.logger.error('worker_registration_lost', { status: error.status });
          this.stopping = true;
          await this.runtime.execute('stop').catch(() => {});
          break;
        }
        this.failures += 1;
        this.logger.warn('wispbyte_poll_failed', { failures: this.failures, error: error.message });
        const delay = Math.min(60000, 1500 * (2 ** Math.min(this.failures, 5))) + Math.floor(Math.random() * 1000);
        await cancellableSleep(delay, this.stopController.signal);
      }
    }
  }

  async stop() {
    this.stopping = true;
    this.stopController?.abort();
    this.activeController?.abort();
    await this.loopPromise?.catch(() => {});
  }
}

module.exports = WispbytePoller;

