'use strict';

const { MinecraftSession } = require('../game/minecraft-session');
const WorkerRuntime = require('./worker-runtime');
const ManagerReporter = require('../transports/manager-reporter');
const WispbytePoller = require('../transports/wispbyte-poller');
const WispbyteKeepAlive = require('./wispbyte-keepalive');

const FleetState = Object.freeze({
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING'
});

const delay = (ms, signal) => new Promise((resolve) => {
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
  timer.unref?.();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

function scopeLogger(logger, workerId) {
  const scoped = {};
  for (const level of ['info', 'warn', 'error', 'debug']) {
    scoped[level] = (message, fields = {}) => logger[level](message, { workerId, ...fields });
  }
  return scoped;
}

class WorkerFleet {
  constructor(config, logger, { fetchImpl = global.fetch } = {}) {
    this.config = config;
    this.logger = logger;
    this.state = FleetState.STOPPED;
    this.stopping = false;
    this.stopController = new AbortController();
    this.heartbeatTimer = null;
    this.resourceTimer = null;
    this.lastResourceWarningAt = 0;
    this.lastCpuSample = process.cpuUsage();
    this.lastResourceSampleAt = Date.now();
    this.instances = new Map();
    this.bootstrapRetryTimers = new Map();
    this.wispbyteKeepAlive = new WispbyteKeepAlive(config.wispbyte, logger, { fetchImpl });

    for (const botConfig of config.bots) {
      const botLogger = scopeLogger(logger, botConfig.workerId);
      const session = new MinecraftSession(botConfig, botLogger);
      const reporter = new ManagerReporter({
        baseUrl: botConfig.managerUrl, workerId: botConfig.workerId,
        secret: botConfig.secret, logger: botLogger, fetchImpl
      });
      const refreshManagerConfig = async ({ signal } = {}) => {
        if (signal?.aborted) throw new Error('Aborted');
        const previousRestriction = session.restriction;
        const state = await reporter.bootstrap({ signal });
        if (signal?.aborted) throw new Error('Aborted');
        session.applyManagerSettings(state.settings);
        session.applyManagerCredentials(state.credentials);
        session.restoreManagerState(state);
        const wasManagerHold = ['manager_check_failed', 'manager_hold'].includes(previousRestriction);
        if (wasManagerHold && !session.isHeld()) {
          try {
            await reporter.heartbeat(session.getStatus(), { signal });
          } catch (error) {
            session.requireManualResume('manager_check_failed');
            throw error;
          }
        }
        return state;
      };
      reporter.onSettingsChanged = () => refreshManagerConfig().catch((err) => {
        botLogger.debug?.('worker_live_settings_refresh_failed', { error: err?.message });
        throw err;
      });
      const runtime = new WorkerRuntime(session, botConfig, botLogger, { refreshManagerConfig });
      const poller = botConfig.transport === 'wispbyte-poll'
        ? new WispbytePoller({ config: botConfig, runtime, reporter, logger: botLogger, fetchImpl }) : null;
      const instance = { config: botConfig, session, runtime, reporter, poller, refreshManagerConfig };
      this.instances.set(botConfig.workerId, instance);

      session.on('event', (event) => {
        reporter.enqueueEvent(event);
      });
      session.on('state', (status) => {
        void reporter.heartbeat(status).catch(() => {});
      });
    }
  }

  get(workerId) { return this.instances.get(String(workerId || '')) || null; }
  list() { return [...this.instances.values()]; }

  scheduleManagerBootstrapRetry(instance) {
    const workerId = instance.config.workerId;
    if (this.stopping || this.bootstrapRetryTimers.has(workerId)) return;
    const delayMs = 30000;
    this.logger.info('worker_manager_bootstrap_retry_scheduled', { workerId, delayMs });
    const timer = setTimeout(async () => {
      this.bootstrapRetryTimers.delete(workerId);
      if (this.stopping) return;
      try {
        await instance.refreshManagerConfig();
        if (!instance.session.hasCredentials()) {
          throw new Error('Manager bootstrap has no usable Minecraft credentials yet.');
        }
        if (instance.session.isHeld()) {
          this.logger.info('worker_manager_bootstrap_restored_but_held', {
            workerId, restriction: instance.session.getStatus().restriction
          });
          this.scheduleManagerBootstrapRetry(instance);
          return;
        }
        this.logger.info('worker_manager_bootstrap_recovered', { workerId });
        if (this.config.autoStart && !this.stopping) {
          await instance.runtime.execute('start', {}, { skipManagerRefresh: true }).catch((error) => {
            this.logger.warn('worker_auto_start_failed', { workerId, error: error.message });
          });
        }
      } catch (error) {
        if (this.stopping) return;
        this.logger.warn('worker_manager_bootstrap_retry_failed', { workerId, error: error.message });
        this.scheduleManagerBootstrapRetry(instance);
      }
    }, delayMs);
    timer.unref?.();
    this.bootstrapRetryTimers.set(workerId, timer);
  }

  health() {
    const memory = process.memoryUsage();
    return {
      botCount: this.instances.size,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      wispbyteKeepAlive: this.wispbyteKeepAlive.getStatus()
    };
  }

  sampleResources() {
    const now = Date.now();
    const elapsedMs = Math.max(100, now - this.lastResourceSampleAt);
    const cpuDelta = process.cpuUsage(this.lastCpuSample);
    this.lastCpuSample = process.cpuUsage();
    this.lastResourceSampleAt = now;
    const memory = process.memoryUsage();
    const metrics = {
      cpuPercent: Math.min(100, ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000)) * 100),
      rssMb: memory.rss / 1024 / 1024,
      heapUsedMb: memory.heapUsed / 1024 / 1024
    };
    for (const instance of this.instances.values()) {
      instance.session.updateResourceMetrics(metrics);
      instance.session.sampleNetworkMetrics(now);
    }
    return metrics;
  }

  async start() {
    if (this.state === FleetState.STARTING || this.state === FleetState.RUNNING || this.heartbeatTimer) return;
    this.state = FleetState.STARTING;
    this.stopping = false;
    this.stopController = new AbortController();
    for (const instance of this.instances.values()) {
      instance.reporter?.reset?.();
    }
    this.wispbyteKeepAlive.start();

    for (const instance of this.instances.values()) {
      try {
        await instance.refreshManagerConfig();
        void instance.reporter.heartbeat(instance.runtime.status()).catch(() => {});
      } catch (error) {
        instance.session.requireManualResume('manager_check_failed');
        this.logger.warn('worker_bootstrap_check_failed', { workerId: instance.config.workerId, error: error.message });
        this.scheduleManagerBootstrapRetry(instance);
      }
    }
    if (this.stopping) {
      this.state = FleetState.STOPPED;
      return;
    }

    for (const instance of this.instances.values()) {
      if (instance.poller) void instance.poller.start();
    }

    this.heartbeatTimer = setInterval(() => {
      for (const instance of this.instances.values()) {
        // Wispbyte poll transport already includes live status in every /poll request;
        // also do not spam /heartbeat while poller is stopping or auth-paused
        if (instance.poller && (instance.poller.stopping || instance.poller.authPaused || instance.poller.failures === 0)) {
          continue;
        }
        void instance.reporter.heartbeat(instance.runtime.status()).catch((error) => {
          this.logger.warn('manager_heartbeat_failed', { workerId: instance.config.workerId, error: error.message });
        });
      }
    }, 45000);
    this.heartbeatTimer.unref?.();

    this.resourceTimer = setInterval(() => {
      const metrics = this.sampleResources();
      const rssMb = Math.round(metrics.rssMb);

      // Memory Watchdog (Trụ cột 1.1: Tự động dọn RAM nếu > 350MB)
      if (rssMb > 350) {
        for (const instance of this.instances.values()) {
          instance.session.pruneMemory?.();
        }
        if (typeof global.gc === 'function') {
          try { global.gc(); } catch (_) {}
        }
      }

      if (rssMb >= this.config.rssWarnMb && Date.now() - this.lastResourceWarningAt >= 300000) {
        this.lastResourceWarningAt = Date.now();
        this.logger.warn('worker_memory_high', { rssMb, thresholdMb: this.config.rssWarnMb, botCount: this.instances.size });
      }
    }, 20000);
    this.resourceTimer.unref?.();

    this.state = FleetState.RUNNING;

    if (this.config.autoStart) {
      let position = 0;
      for (const instance of this.instances.values()) {
        if (this.stopping) break;
        // Trì hoãn nếu RAM vượt trần 440MB để tránh OOM
        const mem = process.memoryUsage();
        if (mem.rss > 440 * 1024 * 1024) {
          this.logger.warn('bot_spawn_delayed_high_memory', { rssMb: Math.round(mem.rss / (1024 * 1024)) });
          await delay(5000, this.stopController.signal);
        }
        if (position > 0) await delay(8000, this.stopController.signal);
        if (!this.stopping && !instance.session.isHeld()) {
          if (!instance.session.hasCredentials()) {
            this.logger.info('worker_auto_start_skipped_no_credentials', { workerId: instance.config.workerId });
            position += 1;
            continue;
          }
          await instance.runtime.execute('start', {}, { skipManagerRefresh: true }).catch((error) => {
            this.logger.warn('worker_auto_start_failed', { workerId: instance.config.workerId, error: error.message });
          });
        }
        position += 1;
      }
    }
  }

  async stop() {
    if (this.state === FleetState.STOPPING || this.state === FleetState.STOPPED) return;
    this.state = FleetState.STOPPING;
    this.stopping = true;
    this.stopController?.abort();
    this.wispbyteKeepAlive.stop();
    for (const timer of this.bootstrapRetryTimers.values()) clearTimeout(timer);
    this.bootstrapRetryTimers.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.resourceTimer) clearInterval(this.resourceTimer);
    this.heartbeatTimer = null;
    this.resourceTimer = null;
    await Promise.all(this.list().map(async (instance) => {
      instance.reporter?.stop?.();
      await instance.poller?.stop();
      await instance.session.stop('process_shutdown');
    }));
    this.state = FleetState.STOPPED;
  }
}

module.exports = WorkerFleet;
