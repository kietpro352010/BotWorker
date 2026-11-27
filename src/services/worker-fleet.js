'use strict';

const { monitorEventLoopDelay } = require('node:perf_hooks');
const { MinecraftSession } = require('../game/minecraft-session');
const WorkerRuntime = require('./worker-runtime');
const ManagerReporter = require('../transports/manager-reporter');
const WispbytePoller = require('../transports/wispbyte-poller');
const { ManagerUrlPool } = require('../transports/manager-urls');
const { resolveWorkerFetch } = require('../transports/http-client');
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
    this.lastForcedGcAt = 0;
    this.lastCpuSample = process.cpuUsage();
    this.lastResourceSampleAt = Date.now();
    this.instances = new Map();
    this.bootstrapRetryTimers = new Map();
    this.loopDelayMonitor = null;
    try {
      if (typeof monitorEventLoopDelay === 'function') {
        this.loopDelayMonitor = monitorEventLoopDelay({ resolution: 50 });
        this.loopDelayMonitor.enable();
      }
    } catch (_) {
      this.loopDelayMonitor = null;
    }
    const effectiveFetch = resolveWorkerFetch(fetchImpl);
    this.wispbyteKeepAlive = new WispbyteKeepAlive(config.wispbyte, logger, { fetchImpl: effectiveFetch });

    const basePoolUrls = [];
    if (config.managerUrl) basePoolUrls.push(config.managerUrl);
    if (Array.isArray(config.managerUrls)) basePoolUrls.push(...config.managerUrls);
    for (const botConfig of config.bots) {
      if (botConfig.managerUrl) basePoolUrls.push(botConfig.managerUrl);
      if (Array.isArray(botConfig.managerUrls)) basePoolUrls.push(...botConfig.managerUrls);
    }
    this.sharedUrlPool = new ManagerUrlPool({
      baseUrl: config.managerUrl || config.bots?.[0]?.managerUrl || '',
      managerUrls: basePoolUrls,
      cacheFilePath: config.managerUrlCacheFile !== undefined
        ? config.managerUrlCacheFile
        : config.bots?.[0]?.managerUrlCacheFile
    });

    for (const botConfig of config.bots) {
      const botLogger = scopeLogger(logger, botConfig.workerId);
      const session = new MinecraftSession(botConfig, botLogger);
      const sharePool = !botConfig.managerUrl || !config.managerUrl || botConfig.managerUrl === config.managerUrl;
      const reporter = new ManagerReporter({
        baseUrl: botConfig.managerUrl,
        managerUrls: botConfig.managerUrls,
        cacheFilePath: botConfig.managerUrlCacheFile,
        ...(sharePool ? { urlPool: this.sharedUrlPool } : {}),
        workerId: botConfig.workerId,
        secret: botConfig.secret,
        logger: botLogger,
        fetchImpl: effectiveFetch
      });
      let instanceRef = null;
      const refreshManagerConfig = async ({ signal, applyManualStop = true } = {}) => {
        if (signal?.aborted) throw new Error('Aborted');
        const previousRestriction = session.restriction;
        const state = await reporter.bootstrap({ signal });
        if (signal?.aborted) throw new Error('Aborted');
        const manuallyStopped = Boolean(state?.manuallyStopped);
        if (instanceRef) instanceRef.managerManuallyStopped = manuallyStopped;
        session.applyManagerSettings(state.settings);
        session.applyManagerCredentials(state.credentials);
        session.restoreManagerState(state);
        if (
          applyManualStop
          && manuallyStopped
          && (!session.manualStop || session.bot || ['starting', 'connecting', 'online', 'reconnecting'].includes(session.state))
        ) {
          await session.stop('manager_offline_stop', { signal }).catch((err) => {
            botLogger.warn?.('worker_manual_stop_sync_failed', { error: err?.message });
          });
        }
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
        ? new WispbytePoller({ config: botConfig, runtime, reporter, logger: botLogger, fetchImpl: effectiveFetch }) : null;
      const instance = { config: botConfig, session, runtime, reporter, poller, managerManuallyStopped: false, refreshManagerConfig };
      instanceRef = instance;
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
        if (instance.managerManuallyStopped) {
          this.logger.info('worker_auto_start_skipped_manual_stop', { workerId });
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
    const lagMeanMs = this.loopDelayMonitor ? Number((this.loopDelayMonitor.mean / 1e6).toFixed(2)) : 0;
    const lagP99Ms = this.loopDelayMonitor ? Number((this.loopDelayMonitor.percentile(99) / 1e6).toFixed(2)) : 0;
    return {
      fleetState: this.state,
      botCount: this.instances.size,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      eventLoopLagMs: {
        mean: Number.isFinite(lagMeanMs) ? lagMeanMs : 0,
        p99: Number.isFinite(lagP99Ms) ? lagP99Ms : 0
      },
      wispbyteKeepAlive: this.wispbyteKeepAlive.getStatus()
    };
  }

  pruneAllMemory() {
    for (const instance of this.instances.values()) {
      instance.session.pruneMemory?.();
    }
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
      if (instance.session.bot) {
        instance.session.sampleNetworkMetrics(now);
      } else {
        instance.session.bandwidthRxBps = 0;
        instance.session.bandwidthTxBps = 0;
        instance.session.networkSampleAt = now;
      }
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

    let pollerSlotIndex = 0;
    for (const instance of this.instances.values()) {
      if (instance.poller) {
        if (pollerSlotIndex === 0) {
          void instance.poller.start();
        } else {
          const staggerTimer = setTimeout(() => {
            if (!this.stopping) void instance.poller.start();
          }, pollerSlotIndex * 350);
          staggerTimer.unref?.();
        }
        pollerSlotIndex += 1;
      }
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

    const resourceIntervalMs = this.config.transport === 'wispbyte-poll' ? 45000 : 30000;
    const pruneThresholdMb = this.config.platform === 'wispbyte' ? 230 : 250;
    this.resourceTimer = setInterval(() => {
      const metrics = this.sampleResources();
      const rssMb = Math.round(metrics.rssMb);

      // Proactive lightweight memory pruning to prevent Wispbyte RAM spikes
      if (rssMb > pruneThresholdMb) {
        this.pruneAllMemory();
      }

      // Emergency Memory Watchdog (>350MB RSS, cooldown 180s tránh V8 GC liên tục)
      if (rssMb > 350) {
        this.pruneAllMemory();
        const nowGc = Date.now();
        if (typeof global.gc === 'function' && nowGc - this.lastForcedGcAt >= 180000) {
          this.lastForcedGcAt = nowGc;
          try { global.gc(); } catch (_) {}
        }
      }

      if (rssMb >= this.config.rssWarnMb && Date.now() - this.lastResourceWarningAt >= 300000) {
        this.lastResourceWarningAt = Date.now();
        this.logger.warn('worker_memory_high', { rssMb, thresholdMb: this.config.rssWarnMb, botCount: this.instances.size });
      }
    }, resourceIntervalMs);
    this.resourceTimer.unref?.();

    this.state = FleetState.RUNNING;

    if (this.config.autoStart) {
      let position = 0;
      for (const instance of this.instances.values()) {
        if (this.stopping) break;
        // Trì hoãn nếu RAM vượt trần 400MB để tránh OOM
        const mem = process.memoryUsage();
        if (mem.rss > 400 * 1024 * 1024) {
          this.logger.warn('bot_spawn_delayed_high_memory', { rssMb: Math.round(mem.rss / (1024 * 1024)) });
          await delay(5000, this.stopController.signal);
        }
        if (position > 0) await delay(8000, this.stopController.signal);
        if (!this.stopping && !instance.session.isHeld()) {
          if (instance.managerManuallyStopped) {
            this.logger.info('worker_auto_start_skipped_manual_stop', { workerId: instance.config.workerId });
            position += 1;
            continue;
          }
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
    try { this.loopDelayMonitor?.disable?.(); } catch (_) {}
    await Promise.all(this.list().map(async (instance) => {
      const hadPendingResults = Boolean(instance.poller?.pendingResults?.length > 0);
      if (hadPendingResults && typeof instance.poller?.drainPendingResults === 'function') {
        await instance.poller.drainPendingResults({ timeoutMs: 2000 }).catch(() => {});
      }
      await instance.poller?.stop();
      const wasActiveSession = Boolean(instance.session?.bot || (instance.session?.state && instance.session.state !== 'stopped'));
      await instance.session.stop('process_shutdown');
      if (typeof instance.reporter?.drain === 'function' && (wasActiveSession || instance.reporter?.eventQueue?.length > 0)) {
        await instance.reporter.drain({
          finalStatus: wasActiveSession ? instance.session.getStatus() : null,
          timeoutMs: 2000
        }).catch(() => {});
      }
      instance.reporter?.stop?.();
    }));
    this.state = FleetState.STOPPED;
  }
}

module.exports = WorkerFleet;
