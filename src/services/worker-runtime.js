'use strict';

const ACTIONS = new Set([
  'start', 'stop', 'restart', 'reconnect', 'status', 'chat', 'reset', 'set-afk-mode', 'set-proxy',
  'respawn', 'inventory', 'look', 'toss', 'window_click', 'window_close'
]);

const LIFECYCLE_ACTIONS = new Set(['start', 'stop', 'restart', 'reconnect', 'reset']);

class WorkerRuntime {
  constructor(session, config, logger, { refreshManagerConfig } = {}) {
    this.session = session;
    this.config = config;
    this.logger = logger;
    this.refreshManagerConfig = refreshManagerConfig || (async () => {});
    this.startedAt = new Date().toISOString();
    this.execution = Promise.resolve();
    this.pendingCommands = 0;
    this.commandTimes = [];
    this.activeLifecycle = null;
  }

  async execute(action, payload = {}) {
    if (!ACTIONS.has(action)) throw new Error(`Unsupported worker action: ${action}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Command payload must be an object.');
    if (Buffer.byteLength(JSON.stringify(payload)) > 4096) throw new Error('Command payload is too large.');
    this.applyCommandLimit();
    if (this.pendingCommands >= 10) throw new Error('Worker command queue is busy. Try again shortly.');

    // Concurrency guard: Do not start conflicting lifecycle commands concurrently
    if (LIFECYCLE_ACTIONS.has(action) && this.activeLifecycle) {
      throw new Error(`A lifecycle operation (${this.activeLifecycle}) is already in progress. Conflicting ${action} command rejected.`);
    }

    const timeoutMs = LIFECYCLE_ACTIONS.has(action) ? 15000 : 10000;
    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`Worker action "${action}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timeoutTimer.unref?.();
    });

    const runTask = async () => {
      if (LIFECYCLE_ACTIONS.has(action)) {
        this.activeLifecycle = action;
      }
      try {
        return await Promise.race([this.executeNow(action, payload), timeoutPromise]);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (LIFECYCLE_ACTIONS.has(action)) {
          this.activeLifecycle = null;
        }
      }
    };

    this.pendingCommands += 1;
    const task = this.execution.then(() => runTask());
    this.execution = task.catch(() => {});
    try {
      return await task;
    } finally {
      this.pendingCommands = Math.max(0, this.pendingCommands - 1);
      if (this.pendingCommands === 0) {
        this.execution = Promise.resolve();
      }
    }
  }

  applyCommandLimit() {
    const now = Date.now();
    this.commandTimes = this.commandTimes.filter((time) => now - time < 60000);
    if (this.commandTimes.length >= 30) throw new Error('Worker command rate limit reached. Try again in a minute.');
    this.commandTimes.push(now);
  }

  async executeNow(action, payload) {
    switch (action) {
      case 'start':
        await this.refreshManagerConfig();
        return this.session.start();
      case 'stop': return this.session.stop('manager_stop');
      case 'restart':
      case 'reconnect':
        await this.refreshManagerConfig();
        return this.session.restart();
      case 'status': return this.status();
      case 'chat': return this.session.sendChat(payload.message || payload.text);
      case 'reset': return this.session.resetData();
      case 'set-afk-mode': return this.session.setAfkMode(payload.mode);
      case 'set-proxy': return this.session.setProxy(payload.url || payload.proxy || payload.proxyUrl);
      case 'respawn': return this.session.respawn();
      case 'inventory': return this.session.handleInventory(payload);
      case 'look': return this.session.look(payload.yaw, payload.pitch);
      case 'toss': return this.session.toss(payload);
      case 'window_click': return this.session.clickWindow(payload);
      case 'window_close': return this.session.closeWindow();
      default: throw new Error(`Unsupported worker action: ${action}`);
    }
  }

  status() {
    return {
      ...this.session.getStatus(),
      processStartedAt: this.startedAt,
      pendingCommands: this.pendingCommands,
      activeLifecycle: this.activeLifecycle || null
    };
  }
}

module.exports = WorkerRuntime;
module.exports.ACTIONS = ACTIONS;
module.exports.LIFECYCLE_ACTIONS = LIFECYCLE_ACTIONS;
