'use strict';

const EventEmitter = require('node:events');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const AfkController = require('./afk-controller');
const LobbyNavigator = require('./lobby-navigator');
const ServerMonitor = require('./server-monitor');
const {
  ServerAuth, cleanText, normalize, isRestrictedMinecraftCommand,
  getLocationKind, isVerificationSuccessNotice, extractChatMessage
} = require('./server-auth');
const { parseSocksProxy } = require('../config/proxy');
const { normalizeState } = require('../domain/worker-state');
const { DISABLED_PLUGINS, attachEarlyPacketDropFilter, applyEcoPhysics, startChunkPruner } = require('./packet-optimization');
const { TIME_ZONE, isMaintenanceWindow, nextMaintenanceBoundary } = require('../services/maintenance-window');

function classifyServerText(message) {
  const text = normalize(message);
  if (/bao tri|maintenance|server restart|may chu dang khoi dong/.test(text)) return 'maintenance';
  if (/your ip is banned|ip bi cam|dia chi ip cua ban da bi|vuot qua gioi han toi da dang ky|gioi han.*dang ky/.test(text)) return 'ip_limited';
  if (/you (?:are|have been) banned|permanently banned|tai khoan.*bi cam|ban vinh vien|bi ban khoi server/.test(text)) return 'banned';
  return null;
}

class MinecraftSession extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.state = 'stopped';
    this.bot = null;
    this.hostIndex = 0;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.locationTimer = null;
    this.lastLocationKind = 'unknown';
    this.lastAuthSendAt = 0;
    this.generation = 0;
    this.reconnectAttempts = 0;
    this.reconnectCount = 0;
    this.connectedAt = null;
    this.username = String(config.mc.username || '').trim();
    this.password = String(config.mc.password || '');
    this.afkMode = 'still';
    this.proxy = config.mc.proxy;
    this.manualStop = true;
    this.restriction = null;
    this.lastError = null;
    this.lastKickReason = null;
    this.lastStateAt = new Date().toISOString();
    this.maintenanceWindow = isMaintenanceWindow();
    this.maintenanceTimer = null;
    this.chunkPruneTimer = null;
    this.networkSockets = new Map();
    this.bandwidthRxBps = 0;
    this.bandwidthTxBps = 0;
    this.networkSampleAt = Date.now();
    this.resourceMetrics = { cpuPercent: 0, rssMb: 0, heapUsedMb: 0 };
    this.afk = new AfkController({ ...config.afk, logger });
    this.auth = new ServerAuth({ password: this.password, enabled: config.mc.authEnabled, logger });
    this.navigator = new LobbyNavigator({
      joinCommand: config.joinCommand, joinDelayMs: config.joinDelayMs, logger
    });
    this.monitor = new ServerMonitor();
    this.isEquippingTotem = false;
    this.scheduleMaintenanceBoundary();
  }

  setState(nextState, detail = '') {
    this.state = normalizeState(nextState);
    this.lastStateAt = new Date().toISOString();
    this.emit('state', this.getStatus());
    this.logger.info('worker_state_changed', { state: this.state, detail });
  }

  async start() {
    if (!this.hasCredentials()) {
      this.manualStop = true;
      this.lastError = 'Minecraft account credentials are not configured in Discord Manager.';
      this.setState('error', 'credentials_missing');
      this.emit('event', { type: 'credentials_missing', message: 'Set this worker account in the private Discord panel before starting.' });
      return this.getStatus();
    }
    this.restriction = null;
    this.manualStop = false;
    if (isMaintenanceWindow()) {
      this.maintenanceWindow = true;
      this.clearTimers();
      this.setState('maintenance', 'fixed_maintenance_window');
      this.emit('event', { type: 'maintenance_window', message: 'Reconnect is paused until 05:30 Vietnam time (UTC+7).'});
      return this.getStatus();
    }
    if (!this.manualStop && this.bot && !['stopped', 'error', 'ip_limited', 'banned'].includes(this.state)) return this.getStatus();
    this.reconnectAttempts = 0;
    this.clearTimers();
    return this.connect();
  }

  async connect() {
    if (isMaintenanceWindow()) {
      this.maintenanceWindow = true;
      this.clearTimers();
      this.setState('maintenance', 'fixed_maintenance_window');
      return this.getStatus();
    }
    if (!this.hasCredentials()) {
      this.manualStop = true;
      this.lastError = 'Minecraft account credentials are not configured in Discord Manager.';
      this.setState('error', 'credentials_missing');
      return this.getStatus();
    }
    if (this.manualStop) return this.getStatus();
    if (this.bot && ['connecting', 'authenticating', 'entering', 'online'].includes(this.state)) return this.getStatus();
    this.clearTimers();
    this.afk.stop();
    this.navigator.clear();
    this.state = 'connecting';
    this.lastStateAt = new Date().toISOString();
    const host = this.config.mc.hosts[this.hostIndex % this.config.mc.hosts.length];
    const generation = ++this.generation;
    this.emit('state', this.getStatus());
    this.logger.info('minecraft_connecting', { host, port: this.config.mc.port });

    try {
      const options = {
        host, port: this.config.mc.port, username: this.username,
        version: this.config.mc.version,
        viewDistance: this.config.mc.viewDistance,
        auth: this.config.mc.authType === 'microsoft' ? 'microsoft' : 'offline',
        plugins: DISABLED_PLUGINS,
        hideErrors: false
      };
      if (this.proxy) {
        const proxy = this.proxy;
        delete options.host;
        options.fakeHost = host;
        options.connect = (client) => {
          const proxyOptions = {
            proxy: {
              host: proxy.host,
              port: proxy.port,
              type: 5,
              ...(proxy.username ? { userId: proxy.username, password: proxy.password } : {})
            },
            command: 'connect',
            destination: { host, port: this.config.mc.port },
            timeout: this.config.connectTimeoutMs
          };
          SocksClient.createConnection(proxyOptions, (error, info) => {
            if (error) { client.emit('error', error); return; }
            client.setSocket(info.socket);
            client.emit('connect');
          });
        };
      }
      this.bot = mineflayer.createBot(options);
      const bot = this.bot;
      attachEarlyPacketDropFilter(bot);
      this.attachNetworkMetrics(bot);
      this.connectTimer = setTimeout(() => {
        if (this.bot === bot && this.state === 'connecting') {
          this.logger.warn('minecraft_connect_timeout', { host });
          try { bot.end('Connection timeout'); } catch (_) { this.scheduleReconnect(); }
        }
      }, this.config.connectTimeoutMs);
      this.connectTimer.unref?.();

      bot.on('error', (error) => {
        if (this.bot !== bot || generation !== this.generation) return;
        const code = String(error?.code || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 48);
        this.lastError = code ? `Minecraft connection error (${code})` : 'Minecraft connection error';
        this.logger.warn('minecraft_connection_error', { code });
        this.emit('event', { type: 'connection_error', message: this.lastError });
      });
      bot.on('kicked', (reason) => this.onKicked(bot, generation, reason));
      bot.on('end', () => this.onEnd(bot, generation));
      bot.on('message', (json) => this.onMessage(bot, generation, json));
      bot.on('actionBar', (json) => this.onMessage(bot, generation, json));
      bot.on('title', (json) => this.onMessage(bot, generation, json));
      bot.on('chat', (username, message) => this.recordChat(bot, username, message));
      bot.on('whisper', (username, message) => this.recordChat(bot, username, message));
      bot.once('spawn', () => this.onSpawn(bot, generation, host));
      return this.getStatus();
    } catch (error) {
      const code = String(error?.code || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 48);
      this.lastError = code ? `Minecraft connection error (${code})` : 'Minecraft connection error';
      this.setState('error', 'connect_failed');
      this.emit('event', { type: 'connection_error', message: this.lastError });
      this.scheduleReconnect();
      return this.getStatus();
    }
  }

  onSpawn(bot, generation, host) {
    if (this.bot !== bot || generation !== this.generation || this.manualStop) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.reconnectAttempts = 0;
    this.connectedAt = Date.now();
    this.lastError = null;
    this.setState('entering', 'minecraft_spawn');
    this.monitor.attach(bot);
    applyEcoPhysics(bot);
    if (this.chunkPruneTimer) clearInterval(this.chunkPruneTimer);
    this.chunkPruneTimer = startChunkPruner(bot, { intervalMs: 30000, radius: 2 });
    this.navigator.onSpawn(bot);
    this.afk.mode = this.afkMode;
    this.afk.start(bot);

    // Auto Totem & Health / Death monitoring
    bot._client?.on?.('entity_status', (packet) => {
      if (packet && packet.entityId === bot.entity?.id && packet.entityStatus === 35) {
        this.logger.info('totem_popped', { bot: this.username });
        this.emit('event', { type: 'totem_popped', message: 'Totem vừa phát nổ cứu mạng bot! Đang lắp Totem mới vào tay phụ...' });
        void this.fastEquipTotem(bot);
      }
    });

    bot.on('health', () => {
      if (bot.health <= 10) void this.fastEquipTotem(bot);
    });

    bot.on('death', () => {
      const pos = bot.entity?.position;
      const coords = pos ? `X: ${Math.round(pos.x)}, Y: ${Math.round(pos.y)}, Z: ${Math.round(pos.z)}` : 'Không rõ';
      this.logger.warn('bot_died', { coords });
      this.emit('event', { type: 'bot_death', reason: `Bot bị chết tại tọa độ ${coords}` });
    });

    // Check off-hand totem immediately on spawn
    void this.fastEquipTotem(bot);

    this.startLocationMonitor(bot, generation, host);
  }

  async fastEquipTotem(bot) {
    if (!bot || !bot.inventory || this.isEquippingTotem) return;
    const offHand = bot.inventory.slots?.[45];
    if (offHand && offHand.name === 'totem_of_undying') return;

    const totem = bot.inventory.items().find((i) => i && i.name === 'totem_of_undying');
    if (!totem) {
      this.logger.warn('no_totem_in_inventory', { bot: this.username });
      this.emit('event', { type: 'low_totem', count: 0, message: 'Bot đã hết Totem trong túi đồ!' });
      return;
    }

    try {
      this.isEquippingTotem = true;
      await bot.equip(totem, 'off-hand');
      this.logger.info('totem_equipped_offhand', { bot: this.username });
    } catch (err) {
      this.logger.warn('totem_equip_failed', { error: err.message });
    } finally {
      this.isEquippingTotem = false;
    }
  }

  startLocationMonitor(bot, generation, host) {
    if (this.locationTimer) clearInterval(this.locationTimer);
    this.lastLocationKind = 'unknown';

    const check = () => {
      if (this.bot !== bot || generation !== this.generation || this.manualStop) {
        if (this.locationTimer) clearInterval(this.locationTimer);
        this.locationTimer = null;
        return;
      }
      const kind = getLocationKind(bot);
      const prevKind = this.lastLocationKind;
      this.lastLocationKind = kind;

      if (kind === 'login') {
        if (this.state !== 'authenticating') this.setState('authenticating', 'auth_lobby');
        const now = Date.now();
        if (now - this.lastAuthSendAt >= 1500) {
          this.lastAuthSendAt = now;
          if (prevKind === 'login') {
            this.auth.sendDirectAuth(bot, 'dn');
          } else {
            this.auth.sendDirectAuth(bot, 'login');
          }
        }
      } else if (kind === 'lobby') {
        if (this.state !== 'entering') this.setState('entering', 'server_lobby');
        this.navigator.tryJoin(bot);
      } else if (kind === 'other') {
        if (this.state !== 'online') {
          this.setState('online', 'kingmc_in_game');
          this.emit('event', { type: 'online', host, message: 'Đã vào cụm sinh tồn KingMC' });
        }
      }
    };

    setTimeout(check, 800);
    this.locationTimer = setInterval(check, 1500);
    this.locationTimer.unref?.();
  }

  onMessage(bot, generation, json) {
    if (this.bot !== bot || generation !== this.generation) return;
    const text = extractChatMessage(json);
    if (!text) return;
    this.logger.info('minecraft_message_received', { text: text.slice(0, 160) });
    const classification = classifyServerText(text);
    if (classification === 'maintenance') {
      if (this.state === 'maintenance') return;
      this.lastKickReason = 'Server maintenance';
      this.setState('maintenance', 'maintenance_message');
      this.emit('event', { type: 'maintenance', message: 'Server maintenance notice received.' });
      try { bot.quit('server_maintenance'); } catch (_) { try { bot.end('server_maintenance'); } catch (_) {} }
    } else if (classification === 'ip_limited' || classification === 'banned') {
      this.pauseForRestriction(classification, text);
    } else {
      if (this.auth.handleMessage(bot, text)) return;
    }
  }

  onKicked(bot, generation, reason) {
    if (this.bot !== bot || generation !== this.generation) return;
    const text = extractChatMessage(reason) || cleanText(typeof reason === 'string' ? reason : JSON.stringify(reason));
    this.lastKickReason = text.slice(0, 300);
    const isVerificationKick = isVerificationSuccessNotice(text);
    const classification = classifyServerText(text);

    this.emit('event', {
      type: 'kicked',
      reason: this.lastKickReason,
      message: this.lastKickReason
    });

    if (classification === 'ip_limited' || classification === 'banned') {
      this.pauseForRestriction(classification, text);
    } else if (classification === 'maintenance') {
      this.setState('maintenance', 'maintenance_kick');
    } else if (isVerificationKick) {
      this.logger.info('kingmc_verification_kick_detected', { text: this.lastKickReason });
      this.setState('error', 'verification_kick');
      this.reconnectAttempts = 0;
      this.scheduleReconnect(2500);
    } else {
      this.setState('error', 'kicked');
    }
  }

  onEnd(bot, generation) {
    if (this.bot !== bot || generation !== this.generation) return;
    this.bot = null;
    this.connectedAt = null;
    if (this.locationTimer) clearInterval(this.locationTimer);
    this.locationTimer = null;
    this.afk.stop();
    this.monitor.detach();
    this.navigator.clear();
    if (this.chunkPruneTimer) clearInterval(this.chunkPruneTimer);
    this.chunkPruneTimer = null;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.manualStop || ['ip_limited', 'banned'].includes(this.state)) return;
    if (isMaintenanceWindow()) {
      this.maintenanceWindow = true;
      this.setState('maintenance', 'fixed_maintenance_window');
      return;
    }
    if (this.state !== 'maintenance') {
      this.setState('error', 'disconnected');
      this.hostIndex = (this.hostIndex + 1) % this.config.mc.hosts.length;
    }
    this.scheduleReconnect(this.state === 'maintenance' ? this.config.maintenanceWaitMs : undefined);
  }

  pauseForRestriction(kind, message) {
    this.restriction = kind;
    this.lastKickReason = cleanText(message).slice(0, 300);
    this.setState(kind, kind === 'ip_limited' ? 'server_ip_limit' : 'server_ban');
    this.emit('event', { type: kind, message: this.lastKickReason });
    this.manualStop = true;
    this.afk.stop();
    this.monitor.detach();
    this.navigator.clear();
    const bot = this.bot;
    this.bot = null;
    this.connectedAt = null;
    if (bot) { try { bot.end(kind); } catch (_) {} }
  }

  scheduleReconnect(delayOverride) {
    if (this.manualStop || !this.config.autoReconnect || this.reconnectTimer) return;
    if (isMaintenanceWindow()) {
      this.maintenanceWindow = true;
      this.setState('maintenance', 'fixed_maintenance_window');
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectCount += 1;
    const exponential = Math.min(this.config.reconnectMaxMs, this.config.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempts - 1, 8)));
    const jitter = Math.floor(Math.random() * Math.min(5000, exponential * 0.2));
    const delay = delayOverride || exponential + jitter;
    this.setState(this.state === 'maintenance' ? 'maintenance' : 'error', 'reconnect_scheduled');
    this.logger.info('minecraft_reconnect_scheduled', { delayMs: delay, attempt: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async stop(reason = 'manager_stop', { emitEvent = true } = {}) {
    this.manualStop = true;
    this.clearTimers();
    this.afk.stop();
    this.monitor.detach();
    this.navigator.clear();
    if (this.chunkPruneTimer) clearInterval(this.chunkPruneTimer);
    this.chunkPruneTimer = null;
    const bot = this.bot;
    this.bot = null;
    this.connectedAt = null;
    if (bot) { try { bot.quit(reason); } catch (_) { try { bot.end(reason); } catch (_) {} } }
    this.setState('stopped', reason);
    if (emitEvent) this.emit('event', { type: 'stopped', reason });
    return this.getStatus();
  }

  async restart() {
    this.restriction = null;
    await this.stop('manager_restart');
    this.manualStop = false;
    this.reconnectAttempts = 0;
    return this.connect();
  }

  async resetData() {
    await this.stop('manager_reset_data', { emitEvent: false });
    this.username = '';
    this.password = '';
    this.auth.password = '';
    this.reconnectAttempts = 0;
    this.reconnectCount = 0;
    this.lastError = null;
    this.lastKickReason = null;
    this.state = this.restriction || 'stopped';
    this.lastStateAt = new Date().toISOString();
    this.emit('state', this.getStatus());
    return { ok: true, worker: this.getStatus() };
  }

  hasCredentials() {
    return Boolean(this.username && (!this.config.authEnabled || this.password));
  }

  applyManagerCredentials(credentials) {
    if (credentials === null) {
      this.username = '';
      this.password = '';
      this.auth.password = '';
      return true;
    }
    if (!credentials || typeof credentials !== 'object') return false;
    const username = String(credentials.username || '').trim();
    const password = String(credentials.password ?? '');
    if (!username || username.length > 64 || !password || password.length > 256) {
      throw new Error('Manager Minecraft credentials are invalid.');
    }
    this.username = username;
    this.password = password;
    this.auth.password = password;
    return true;
  }

  restoreManagerState({ restricted, restriction, state } = {}) {
    const recoveredRestriction = restriction || (['ip_limited', 'banned'].includes(state) ? state : null);
    if (!restricted && !recoveredRestriction) return false;
    this.restriction = recoveredRestriction || 'manager_hold';
    this.manualStop = true;
    this.state = ['ip_limited', 'banned'].includes(this.restriction) ? this.restriction : 'stopped';
    this.lastStateAt = new Date().toISOString();
    this.logger.warn('worker_hold_restored', { restriction: this.restriction });
    this.emit('state', this.getStatus());
    return true;
  }

  applyManagerSettings(settings = {}) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
    this.afkMode = 'still';
    this.afk.mode = 'still';
    if (Object.hasOwn(settings, 'proxyUrl')) this.proxy = parseSocksProxy(settings.proxyUrl, 'manager proxy');
  }

  requireManualResume(reason = 'manager_check_failed') {
    this.restriction = reason;
    this.manualStop = true;
    this.state = 'stopped';
    this.lastStateAt = new Date().toISOString();
    this.logger.warn('worker_manual_resume_required', { reason });
    this.emit('state', this.getStatus());
  }

  isHeld() { return Boolean(this.restriction); }

  requireOnlineBot() {
    if (!this.bot || !this.bot._client || !['online', 'entering'].includes(this.state)) {
      throw new Error('Worker is not connected to Minecraft.');
    }
    return this.bot;
  }

  sendChat(value) {
    const bot = this.requireOnlineBot();
    const message = String(value || '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
    if (!message || message.length > 256) throw new Error('Chat message must contain 1–256 characters.');
    if (isRestrictedMinecraftCommand(message)) throw new Error('Account registration and password commands are blocked.');
    bot.chat(message);
    this.emit('event', { type: 'chat', message: `[${bot.username}] ${message}` });
    return { ok: true, sent: message };
  }

  setAfkMode(_value) {
    this.afkMode = 'still';
    this.afk.mode = 'still';
    return { ok: true, afkMode: 'still' };
  }

  async setProxy(value) {
    if (this.restriction) throw new Error('Proxy settings cannot be changed while the worker is on a server restriction hold.');
    const proxy = parseSocksProxy(value, 'proxy');
    const shouldReconnect = Boolean(this.bot && ['online', 'entering'].includes(this.state));
    this.proxy = proxy;
    if (shouldReconnect) await this.restart();
    return { ok: true, proxyEnabled: Boolean(proxy), reconnecting: shouldReconnect };
  }

  attachNetworkMetrics(bot) {
    const client = bot?._client;
    const attach = () => {
      const socket = client?.socket;
      if (!socket || this.networkSockets.has(socket)) return;
      this.networkSockets.set(socket, {
        bytesRead: Number(socket.bytesRead) || 0,
        bytesWritten: Number(socket.bytesWritten) || 0
      });
    };
    attach();
    client?.on?.('connect', attach);
    bot?.once?.('inject_allowed', attach);
  }

  updateResourceMetrics(metrics = {}) {
    this.resourceMetrics = {
      cpuPercent: Number.isFinite(metrics.cpuPercent) ? Math.max(0, Math.min(100, metrics.cpuPercent)) : 0,
      rssMb: Number.isFinite(metrics.rssMb) ? Math.max(0, metrics.rssMb) : 0,
      heapUsedMb: Number.isFinite(metrics.heapUsedMb) ? Math.max(0, metrics.heapUsedMb) : 0
    };
  }

  sampleNetworkMetrics(now = Date.now()) {
    let received = 0;
    let sent = 0;
    for (const [socket, previous] of this.networkSockets) {
      const bytesRead = Number(socket.bytesRead) || previous.bytesRead;
      const bytesWritten = Number(socket.bytesWritten) || previous.bytesWritten;
      received += Math.max(0, bytesRead - previous.bytesRead);
      sent += Math.max(0, bytesWritten - previous.bytesWritten);
      previous.bytesRead = bytesRead;
      previous.bytesWritten = bytesWritten;
      if (socket.destroyed && bytesRead === previous.bytesRead && bytesWritten === previous.bytesWritten) this.networkSockets.delete(socket);
    }
    const elapsedSeconds = Math.max(0.1, (now - this.networkSampleAt) / 1000);
    this.bandwidthRxBps = received / elapsedSeconds;
    this.bandwidthTxBps = sent / elapsedSeconds;
    this.networkSampleAt = now;
  }

  scheduleMaintenanceBoundary() {
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    const now = new Date();
    const boundary = nextMaintenanceBoundary(now);
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = null;
      const inside = isMaintenanceWindow();
      this.maintenanceWindow = inside;
      if (inside) this.enterMaintenanceWindow();
      else if (!this.manualStop && !this.restriction) {
        this.reconnectAttempts = 0;
        void this.connect();
      }
      this.scheduleMaintenanceBoundary();
    }, Math.max(50, boundary.getTime() - now.getTime()));
    this.maintenanceTimer.unref?.();
  }

  enterMaintenanceWindow() {
    this.clearTimers();
    if (this.manualStop || this.restriction) return;
    this.afk.stop();
    this.monitor.detach();
    this.navigator.clear();
    if (this.chunkPruneTimer) clearInterval(this.chunkPruneTimer);
    this.chunkPruneTimer = null;
    const bot = this.bot;
    this.bot = null;
    this.connectedAt = null;
    if (bot) { try { bot.end('fixed_maintenance_window'); } catch (_) {} }
    this.setState('maintenance', 'fixed_maintenance_window');
    this.emit('event', { type: 'maintenance_window', message: 'Scheduled stop 04:30–05:30 Vietnam time (UTC+7).' });
  }

  recordChat(bot, username, message) {
    if (this.bot !== bot || username === bot.username) return;
    const clean = cleanText(message).replace(/[\r\n\t]+/g, ' ').slice(0, 240);
    if (!clean) return;
    this.emit('event', { type: 'chat', message: `[${String(username || 'player').slice(0, 40)}] ${clean}` });
  }

  clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.locationTimer) clearInterval(this.locationTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.locationTimer = null;
  }

  getStatus() {
    return {
      workerId: this.config.workerId, transport: this.config.transport, state: this.state,
      afkMode: this.afkMode, proxyEnabled: Boolean(this.proxy),
      username: this.username || 'N/A', credentialsConfigured: this.hasCredentials(),
      connected: Boolean(this.bot && this.bot.player), reconnectAttempts: this.reconnectAttempts,
      reconnectCount: this.reconnectCount,
      uptimeSeconds: this.connectedAt ? Math.max(0, Math.floor((Date.now() - this.connectedAt) / 1000)) : 0,
      maintenanceWindow: this.maintenanceWindow,
      maintenanceTimeZone: TIME_ZONE,
      maintenanceStart: '04:30', maintenanceEnd: '05:30',
      ...this.resourceMetrics, bandwidthRxBps: this.bandwidthRxBps, bandwidthTxBps: this.bandwidthTxBps,
      restriction: this.restriction,
      ...this.monitor.snapshot(),
      lastError: this.lastError, lastKickReason: this.lastKickReason, lastStateAt: this.lastStateAt
    };
  }
}

module.exports = { MinecraftSession, classifyServerText };

