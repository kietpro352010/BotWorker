'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  }

  start() {
    if (this.loopPromise) return this.loopPromise;
    this.stopping = false;
    this.loopPromise = this.run().finally(() => { this.loopPromise = null; });
    return this.loopPromise;
  }

  async request(path, payload) {
    const url = `${this.config.managerUrl}${path}`;
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
            catch (error) { result = { ok: false, error: error.message }; }
          }
          await this.request(`/api/v1/workers/${encodeURIComponent(this.config.workerId)}/result`, {
            commandId: command.commandId, action: command.action, result, completedAt: new Date().toISOString()
          });
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
        await sleep(delay);
      }
    }
  }

  async stop() {
    this.stopping = true;
    this.activeController?.abort();
    await this.loopPromise?.catch(() => {});
  }
}

module.exports = WispbytePoller;

