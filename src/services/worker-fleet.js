'use strict';

const { MinecraftSession } = require('../game/minecraft-session');
const WorkerRuntime = require('./worker-runtime');
const ManagerReporter = require('../transports/manager-reporter');
const WispbytePoller = require('../transports/wispbyte-poller');
const WispbyteKeepAlive = require('./wispbyte-keepalive');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    this.stopping = false;
    this.heartbeatTimer = null;
    this.resourceTimer = null;
    this.lastResourceWarningAt = 0;
    this.lastCpuSample = process.cpuUsage();
    this.lastResourceSampleAt = Date.now();
    this.instances = new Map();
    this.wispbyteKeepAlive = new WispbyteKeepAlive(config.wispbyte, logger, { fetchImpl });

    for (const botConfig of config.bots) {
      const botLogger = scopeLogger(logger, botConfig.workerId);
      const session = new MinecraftSession(botConfig, botLogger);
      const reporter = new ManagerReporter({
        baseUrl: botConfig.managerUrl, workerId: botConfig.workerId,
        secret: botConfig.secret, logger: botLogger, fetchImpl
      });
      const refreshManagerConfig = async () => {
        const state = await reporter.bootstrap();
        session.applyManagerSettings(state.settings);
        session.applyManagerCredentials(state.credentials);
        session.restoreManagerState(state);
        return state;
      };
      const runtime = new WorkerRuntime(session, botConfig, botLogger, { refreshManagerConfig });
      const poller = botConfig.transport === 'wispbyte-poll'
        ? new WispbytePoller({ config: botConfig, runtime, reporter, logger: botLogger, fetchImpl }) : null;
      const instance = { config: botConfig, session, runtime, reporter, poller };
      this.instances.set(botConfig.workerId, instance);

      session.on('event', (event) => {
        void reporter.sendEvent(event).catch((error) => logger.warn('manager_event_delivery_failed', {
          workerId: botConfig.workerId, error: error.message
        }));
      });
      session.on('state', (status) => {
        void reporter.heartbeat(status).catch(() => {});
      });
    }
  }

  get(workerId) { return this.instances.get(String(workerId || '')) || null; }
  list() { return [...this.instances.values()]; }

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
    if (this.heartbeatTimer) return;
    this.stopping = false;
    this.wispbyteKeepAlive.start();

    for (const instance of this.instances.values()) {
      try {
        const state = await instance.reporter.bootstrap();
        instance.session.applyManagerSettings(state.settings);
        instance.session.applyManagerCredentials(state.credentials);
        instance.session.restoreManagerState(state);
      } catch (error) {
        instance.session.requireManualResume('manager_check_failed');
        this.logger.warn('worker_bootstrap_check_failed', { workerId: instance.config.workerId, error: error.message });
      }
    }
    if (this.stopping) return;

    for (const instance of this.instances.values()) {
      if (instance.poller) void instance.poller.start();
    }

    this.heartbeatTimer = setInterval(() => {
      for (const instance of this.instances.values()) {
        void instance.reporter.heartbeat(instance.runtime.status()).catch((error) => {
          this.logger.warn('manager_heartbeat_failed', { workerId: instance.config.workerId, error: error.message });
        });
      }
    }, 30000);
    this.heartbeatTimer.unref?.();

    this.resourceTimer = setInterval(() => {
      const metrics = this.sampleResources();
      const rssMb = Math.round(metrics.rssMb);
      if (rssMb >= this.config.rssWarnMb && Date.now() - this.lastResourceWarningAt >= 300000) {
        this.lastResourceWarningAt = Date.now();
        this.logger.warn('worker_memory_high', { rssMb, thresholdMb: this.config.rssWarnMb, botCount: this.instances.size });
      }
    }, 10000);
    this.resourceTimer.unref?.();

    if (this.config.autoStart) {
      let position = 0;
      for (const instance of this.instances.values()) {
        if (this.stopping) break;
        if (position > 0) await delay(8000);
        if (!this.stopping && !instance.session.isHeld()) await instance.session.start();
        position += 1;
      }
    }
  }

  async stop() {
    this.stopping = true;
    this.wispbyteKeepAlive.stop();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.resourceTimer) clearInterval(this.resourceTimer);
    this.heartbeatTimer = null;
    this.resourceTimer = null;
    await Promise.all(this.list().map(async (instance) => {
      await instance.poller?.stop();
      await instance.session.stop('process_shutdown');
    }));
  }
}

module.exports = WorkerFleet;
