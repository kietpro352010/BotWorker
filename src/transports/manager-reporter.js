'use strict';

class ManagerReporter {
  constructor({ baseUrl, workerId, secret, fetchImpl = global.fetch, logger }) {
    this.baseUrl = baseUrl;
    this.workerId = workerId;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.managerLatencyMs = null;
  }

  async post(path, payload) {
    if (!this.baseUrl || !this.fetch) return;
    const startedAt = Date.now();
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': this.secret },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`manager_http_${response.status}`);
    this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
  }

  async heartbeat(status) {
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/heartbeat`;
    return this.post(path, {
      status: { ...status, managerLatencyMs: this.managerLatencyMs },
      sentAt: new Date().toISOString()
    });
  }

  async bootstrap() {
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/bootstrap`;
    const startedAt = Date.now();
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      headers: { 'x-worker-secret': this.secret }, signal: AbortSignal.timeout(8000)
    });
    this.managerLatencyMs = Math.max(0, Date.now() - startedAt);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(body.error || `manager_http_${response.status}`);
    return body;
  }

  async sendEvent(event) {
    const path = `/api/v1/workers/${encodeURIComponent(this.workerId)}/events`;
    return this.post(path, { ...event, occurredAt: new Date().toISOString() });
  }
}

module.exports = ManagerReporter;

