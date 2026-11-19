'use strict';

const ACTIONS = new Set([
  'start', 'stop', 'restart', 'reconnect', 'status', 'chat', 'reset', 'set-afk-mode', 'set-proxy',
  'respawn', 'inventory', 'look', 'toss', 'window_click', 'window_close'
]);

const LIFECYCLE_ACTIONS = new Set(['start', 'stop', 'restart', 'reconnect', 'reset', 'set-proxy']);
const CLEANUP_ON_ABORT_ACTIONS = new Set(['start', 'stop', 'restart', 'reconnect', 'reset', 'set-proxy']);

const DEFAULT_EXEC_TIMEOUT_MS = 10000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 15000;
const DEFAULT_QUEUE_TIMEOUT_MS = 30000;
const MAX_PENDING_COMMANDS = 10;
const MAX_TIMEOUT_MS = 120000;

function resolveTimeoutMs(fallback, ...candidates) {
  for (const value of candidates) {
    if (value === undefined || value === null || value === '') continue;
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return Math.min(Math.ceil(num), MAX_TIMEOUT_MS);
    }
  }
  return fallback;
}

function createAbortError(reason, action) {
  if (reason instanceof Error) return reason;
  if (reason && typeof reason === 'object' && typeof reason.message === 'string') {
    return reason;
  }
  const message = typeof reason === 'string' && reason.trim()
    ? reason
    : `Worker action "${action}" was aborted.`;
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

class WorkerRuntime {
  constructor(session, config, logger, { refreshManagerConfig } = {}) {
    this.session = session;
    this.config = config || {};
    this.logger = logger;
    this.refreshManagerConfig = refreshManagerConfig || (async () => {});
    this.startedAt = new Date().toISOString();
    this.execution = Promise.resolve();
    this.pendingCommands = 0;
    this.commandTimes = [];
    this.activeLifecycle = null;
    this.activeLifecycleToken = null;
    this.queuedLifecycles = new Set();
  }

  getQueuedLifecycleAction() {
    const first = this.queuedLifecycles.values().next();
    return first.done ? null : first.value.action;
  }

  async cleanupAbortedLifecycle(action, err) {
    if (!LIFECYCLE_ACTIONS.has(action)) return;
    const reason = err?.code === 'ETIMEDOUT' ? 'command_timeout' : 'command_aborted';
    try {
      let cleanupPromise;
      if (typeof this.session?.abortPending === 'function') {
        cleanupPromise = this.session.abortPending(reason);
      } else if (CLEANUP_ON_ABORT_ACTIONS.has(action) && typeof this.session?.stop === 'function') {
        cleanupPromise = this.session.stop(reason, { emitEvent: false });
      }
      if (cleanupPromise && typeof cleanupPromise.then === 'function') {
        let timer = null;
        try {
          await Promise.race([
            cleanupPromise,
            new Promise((resolve) => {
              timer = setTimeout(resolve, 1000);
              timer.unref?.();
            })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } catch (cleanupErr) {
      this.logger?.warn?.('worker_lifecycle_cleanup_failed', { action, error: cleanupErr?.message });
    }
  }

  async execute(action, payload = {}, options = {}) {
    if (!ACTIONS.has(action)) {
      const err = new Error(`Unsupported worker action: ${action}`);
      err.code = 'UNSUPPORTED_ACTION';
      err.status = 400;
      throw err;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const err = new Error('Command payload must be an object.');
      err.code = 'INVALID_PAYLOAD';
      err.status = 400;
      throw err;
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > 4096) {
      const err = new Error('Command payload is too large.');
      err.code = 'PAYLOAD_TOO_LARGE';
      err.status = 413;
      throw err;
    }
    if (options !== undefined && options !== null && (typeof options !== 'object' || Array.isArray(options))) {
      const err = new Error('Command options must be an object.');
      err.code = 'INVALID_PAYLOAD';
      err.status = 400;
      throw err;
    }

    const externalSignal = options?.signal;
    if (externalSignal?.aborted) {
      throw createAbortError(externalSignal.reason, action);
    }

    this.checkCommandLimit();
    if (this.pendingCommands >= MAX_PENDING_COMMANDS) {
      const err = new Error('Worker command queue is busy. Try again shortly.');
      err.code = 'QUEUE_BUSY';
      err.status = 503;
      throw err;
    }

    // Concurrency guard: reject conflicting lifecycle action if one is active OR queued
    const isLifecycle = LIFECYCLE_ACTIONS.has(action);
    const conflictingLifecycle = this.activeLifecycle || this.getQueuedLifecycleAction();
    if (isLifecycle && conflictingLifecycle) {
      const err = new Error(`A lifecycle operation (${conflictingLifecycle}) is already in progress. Conflicting ${action} command rejected.`);
      err.code = 'LIFECYCLE_CONFLICT';
      err.status = 409;
      throw err;
    }

    this.recordCommandLimit();
    this.pendingCommands += 1;

    const defaultExecMs = isLifecycle ? DEFAULT_LIFECYCLE_TIMEOUT_MS : DEFAULT_EXEC_TIMEOUT_MS;
    const configExecMs = isLifecycle
      ? (this.config?.lifecycleTimeoutMs ?? this.config?.commandTimeoutMs)
      : this.config?.commandTimeoutMs;
    const execTimeoutMs = resolveTimeoutMs(defaultExecMs, options?.timeoutMs, payload.timeoutMs, payload.execTimeoutMs, configExecMs);
    const queueTimeoutMs = resolveTimeoutMs(DEFAULT_QUEUE_TIMEOUT_MS, options?.queueTimeoutMs, payload.queueTimeoutMs, this.config?.commandQueueTimeoutMs);

    const lifecycleToken = isLifecycle ? { action } : null;
    if (lifecycleToken) {
      this.queuedLifecycles.add(lifecycleToken);
    }

    let slotReleased = false;
    const releaseSlot = () => {
      if (lifecycleToken) {
        this.queuedLifecycles.delete(lifecycleToken);
      }
      if (!slotReleased) {
        slotReleased = true;
        this.pendingCommands = Math.max(0, this.pendingCommands - 1);
      }
    };

    let cancelled = false;
    let started = false;
    let queueTimer = null;
    let onQueueAbort = null;
    let execPromise = null;
    let releaseSettleLock = null;
    const settleLock = new Promise((resolve) => { releaseSettleLock = resolve; });

    const clearQueueWait = () => {
      if (queueTimer) {
        clearTimeout(queueTimer);
        queueTimer = null;
      }
      if (externalSignal && onQueueAbort) {
        externalSignal.removeEventListener('abort', onQueueAbort);
        onQueueAbort = null;
      }
    };

    const queueWaitAbortPromise = new Promise((_, reject) => {
      const cancelWhileQueued = (err) => {
        if (started || cancelled) return;
        cancelled = true;
        clearQueueWait();
        releaseSlot();
        releaseSettleLock();
        reject(err);
      };

      queueTimer = setTimeout(() => {
        const err = new Error(`Worker action "${action}" timed out waiting in queue after ${queueTimeoutMs}ms.`);
        err.code = 'ETIMEDOUT';
        cancelWhileQueued(err);
      }, queueTimeoutMs);

      if (externalSignal) {
        onQueueAbort = () => cancelWhileQueued(createAbortError(externalSignal.reason, action));
        if (externalSignal.aborted) {
          onQueueAbort();
        } else {
          externalSignal.addEventListener('abort', onQueueAbort, { once: true });
        }
      }
    });

    const runTask = async () => {
      if (cancelled) {
        releaseSettleLock();
        return;
      }
      started = true;
      clearQueueWait();

      if (lifecycleToken) {
        this.queuedLifecycles.delete(lifecycleToken);
        this.activeLifecycle = action;
        this.activeLifecycleToken = lifecycleToken;
      }

      const execController = new AbortController();
      let onExternalAbort = null;
      if (externalSignal) {
        onExternalAbort = () => execController.abort(createAbortError(externalSignal.reason, action));
        if (externalSignal.aborted) {
          onExternalAbort();
        } else {
          externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      let execTimer = null;
      let onExecAbort = null;
      const execTimeoutOrAbortPromise = new Promise((_, reject) => {
        if (execController.signal.aborted) {
          reject(createAbortError(execController.signal.reason, action));
          return;
        }
        onExecAbort = () => {
          reject(createAbortError(execController.signal.reason, action));
        };
        execController.signal.addEventListener('abort', onExecAbort, { once: true });

        execTimer = setTimeout(() => {
          const err = new Error(`Worker action "${action}" timed out after ${execTimeoutMs}ms.`);
          err.code = 'ETIMEDOUT';
          execController.abort(err);
        }, execTimeoutMs);
      });

      execPromise = Promise.resolve().then(() =>
        this.executeNow(action, payload, {
          signal: execController.signal,
          skipManagerRefresh: options?.skipManagerRefresh === true
        })
      );
      execPromise.catch(() => {});

      try {
        return await Promise.race([execPromise, execTimeoutOrAbortPromise]);
      } catch (err) {
        if (execController.signal.aborted) {
          const reason = err?.code === 'ETIMEDOUT' ? 'command_timeout' : 'command_aborted';
          if (isLifecycle) {
            await this.cleanupAbortedLifecycle(action, err);
          } else if (typeof this.session?.cancelPendingOperations === 'function') {
            try { this.session.cancelPendingOperations(reason); } catch (_) {}
          } else if (typeof this.session?.abortPending === 'function') {
            try { this.session.abortPending(reason); } catch (_) {}
          }
        }
        throw err;
      } finally {
        if (execTimer) clearTimeout(execTimer);
        if (onExecAbort) execController.signal.removeEventListener('abort', onExecAbort);
        if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
        if (lifecycleToken) {
          this.queuedLifecycles.delete(lifecycleToken);
          if (this.activeLifecycleToken === lifecycleToken) {
            this.activeLifecycle = null;
            this.activeLifecycleToken = null;
          }
        }
        if (!isLifecycle) {
          // For non-lifecycle tasks, retain execution lock until task terminates (or 10s safety timeout)
          let settleTimer = null;
          const waitSettle = Promise.race([
            execPromise ? execPromise.catch(() => {}) : Promise.resolve(),
            new Promise((r) => { settleTimer = setTimeout(r, 10000); settleTimer.unref?.(); })
          ]);
          waitSettle.finally(() => {
            if (settleTimer) clearTimeout(settleTimer);
            releaseSettleLock();
          });
        } else {
          releaseSettleLock();
        }
      }
    };

    const prevExecution = this.execution;
    this.execution = Promise.allSettled([prevExecution, settleLock]).then(() => undefined);
    const task = prevExecution.then(() => runTask());
    try {
      return await Promise.race([task, queueWaitAbortPromise]);
    } finally {
      clearQueueWait();
      releaseSlot();
    }
  }

  checkCommandLimit() {
    const now = Date.now();
    this.commandTimes = this.commandTimes.filter((time) => now - time < 60000);
    if (this.commandTimes.length >= 30) {
      const err = new Error('Worker command rate limit reached. Try again in a minute.');
      err.code = 'RATE_LIMIT';
      err.status = 429;
      throw err;
    }
  }

  recordCommandLimit() {
    this.commandTimes.push(Date.now());
  }

  applyCommandLimit() {
    this.checkCommandLimit();
    this.recordCommandLimit();
  }

  async executeNow(action, payload, { signal, skipManagerRefresh = false } = {}) {
    if (signal?.aborted) throw createAbortError(signal.reason, action);
    switch (action) {
      case 'start':
        if (!skipManagerRefresh) await this.refreshManagerConfig({ signal });
        if (signal?.aborted) throw createAbortError(signal.reason, action);
        return this.session.start({ signal });
      case 'stop': return this.session.stop('manager_stop', { signal });
      case 'restart':
      case 'reconnect':
        if (!skipManagerRefresh) await this.refreshManagerConfig({ signal });
        if (signal?.aborted) throw createAbortError(signal.reason, action);
        return this.session.restart({ signal });
      case 'status': return this.status();
      case 'chat': return this.session.sendChat(payload.message || payload.text);
      case 'reset': return this.session.resetData({ signal });
      case 'set-afk-mode': return this.session.setAfkMode(payload.mode);
      case 'set-proxy': return this.session.setProxy(payload.url || payload.proxy || payload.proxyUrl, { signal });
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
