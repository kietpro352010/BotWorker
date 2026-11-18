'use strict';

const EventEmitter = require('node:events');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { logMinecraftHostResolution, attachMinecraftConnectionDiagnostics } = require('./connection-diagnostics');
const AfkController = require('./afk-controller');
const LobbyNavigator = require('./lobby-navigator');
const ServerMonitor = require('./server-monitor');
const {
  ServerAuth, cleanText, normalize, isRestrictedMinecraftCommand,
  getLocationKind, isVerificationSuccessNotice, extractChatMessage, redactAuditValue
} = require('./server-auth');
const { parseSocksProxy, createSocksConnector } = require('../config/proxy');
const { normalizeState } = require('../domain/worker-state');
const { DISABLED_PLUGINS, attachEarlyPacketDropFilter, applyEcoPhysics, setPhysicsEnabled, startChunkPruner, stopEntityPruner } = require('./packet-optimization');
const { TIME_ZONE, isMaintenanceWindow, nextMaintenanceBoundary } = require('../services/maintenance-window');

function classifyServerText(message) {
  const text = normalize(message);
  if (/bao tri|maintenance/.test(text)) return 'maintenance';
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
    this.initialLocationTimer = null;
    this._abortListenerCleanup = null;
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
    this.auth = new ServerAuth({ password: this.password, enabled: Boolean(config.authEnabled ?? config.mc?.authEnabled ?? true), logger });
    this.navigator = new LobbyNavigator({
      joinCommand: config.joinCommand, joinDelayMs: config.joinDelayMs, logger,
      isAuthenticated: () => this.auth.isAuthenticated()
    });
    this.monitor = new ServerMonitor();
    this.isEquippingTotem = false;
    this.inventoryRevision = 0;
    this.isVerificationKickPending = false;
    this.pendingReconnectDelayMs = null;
    this.scheduleMaintenanceBoundary();
  }

  setState(nextState, detail = '') {
    this.state = normalizeState(nextState);
    this.lastStateAt = new Date().toISOString();
    this.emit('state', this.getStatus());
    this.logger.info('worker_state_changed', { state: this.state, detail });
  }

  _clearAbortListener() {
    if (this._abortListenerCleanup) {
      try { this._abortListenerCleanup(); } catch (_) {}
      this._abortListenerCleanup = null;
    }
  }

  _abortReasonFromSignal(signal) {
    return signal?.reason?.code === 'ETIMEDOUT' ? 'command_timeout' : 'command_aborted';
  }

  async start({ signal } = {}) {
    if (signal?.aborted) {
      this.abortPending(this._abortReasonFromSignal(signal));
      return this.getStatus();
    }
    if (this.restriction) {
      return {
        ok: false, error: 'worker_restricted', code: 'WORKER_RESTRICTED', status: 409,
        detail: 'Worker is held by a Manager restriction and cannot start.', worker: this.getStatus()
      };
    }
    if (!this.hasCredentials()) {
      this.manualStop = true;
      this.lastError = 'Minecraft account credentials are not configured in Web Dashboard or Discord.';
      this.setState('error', 'credentials_missing');
      this.emit('event', { type: 'credentials_missing', message: 'Set this worker account on the Web Dashboard or Discord before starting.' });
      const worker = this.getStatus();
      return { ok: false, error: 'credentials_missing', code: 'CREDENTIALS_MISSING', status: 422, detail: this.lastError, worker };
    }
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
    return this.connect({ signal });
  }

  async connect({ signal } = {}) {
    if (signal?.aborted) {
      this.abortPending(this._abortReasonFromSignal(signal));
      return this.getStatus();
    }
    if (this.restriction) {
      return {
        ok: false, error: 'worker_restricted', code: 'WORKER_RESTRICTED', status: 409,
        detail: 'Worker is held by a Manager restriction and cannot connect.', worker: this.getStatus()
      };
    }
    if (isMaintenanceWindow()) {
      this.maintenanceWindow = true;
      this.clearTimers();
      this.setState('maintenance', 'fixed_maintenance_window');
      return this.getStatus();
    }
    if (!this.hasCredentials()) {
      this.manualStop = true;
      this.lastError = 'Minecraft account credentials are not configured in Web Dashboard or Discord.';
      this.setState('error', 'credentials_missing');
      const worker = this.getStatus();
      return { ok: false, error: 'credentials_missing', code: 'CREDENTIALS_MISSING', status: 422, detail: this.lastError, worker };
    }
    if (this.manualStop) return this.getStatus();
    if (this.bot && ['connecting', 'authenticating', 'entering', 'online'].includes(this.state)) return this.getStatus();
    if (this.bot) {
      this.cleanupSessionResources(this.bot);
      this.bot = null;
    }
    this.isEquippingTotem = false;
    this.clearTimers();
    this.afk.stop();
    this.navigator.clear();
    this.lastLobbyAuthAt = 0;
    this.lastAuthSendAt = 0;
    this.auth.authenticated = !Boolean(this.config.authEnabled ?? this.config.mc?.authEnabled ?? true);
    this.state = 'connecting';
    this.lastStateAt = new Date().toISOString();
    const host = this.config.mc.hosts[this.hostIndex % this.config.mc.hosts.length];
    const generation = ++this.generation;
    this._clearAbortListener();
    if (signal) {
      const onAbort = () => {
        if (this.generation === generation) {
          this.abortPending(this._abortReasonFromSignal(signal));
        }
      };
      if (signal.aborted) {
        onAbort();
        return this.getStatus();
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this._abortListenerCleanup = () => signal.removeEventListener('abort', onAbort);
    }
    this.emit('state', this.getStatus());
    this.logger.info('minecraft_connecting', { host, port: this.config.mc.port });
    logMinecraftHostResolution(host, this.config.mc.port, this.logger, this.proxy ? 'socks5' : 'direct');

    try {
      const options = {
        host, port: this.config.mc.port, username: this.username,
        version: this.config.mc.version,
        viewDistance: this.config.mc.viewDistance || 'tiny',
        physicsEnabled: true,
        hideErrors: true,
        logErrors: false,
        fakeHost: 'kingmc.vn',
        auth: this.config.mc.authType === 'microsoft' ? 'microsoft' : 'offline',
        plugins: DISABLED_PLUGINS
      };
      if (this.proxy) {
        delete options.host;
        options.fakeHost = 'kingmc.vn';
        options.connect = createSocksConnector(this.proxy, host, this.config.mc.port, {
          timeoutMs: this.config.connectTimeoutMs || 10000,
          logger: this.logger
        });
      }
      this.bot = mineflayer.createBot(options);
      const bot = this.bot;
      if (typeof bot.blockAt !== 'function') bot.blockAt = () => null;
      attachEarlyPacketDropFilter(bot);
      this.attachNetworkMetrics(bot);
      attachMinecraftConnectionDiagnostics(bot, { host, port: this.config.mc.port, logger: this.logger });

      if (bot._client) {
        bot._client.on('error', (err) => {
          const msg = err && err.message ? err.message : String(err || '');
          if (
            msg.includes('bounds of the managed data') ||
            msg.includes('Attempted to read beyond') ||
            msg.includes('chunk failed to load') ||
            msg.includes('Partial packet')
          ) {
            return;
          }
          this.logger.warn('minecraft_tcp_socket_error', { host, port: this.config.mc.port, error: msg });
        });
      }

      this.connectTimer = setTimeout(() => {
        if (this.bot === bot && generation === this.generation && !this.manualStop && this.state === 'connecting') {
          this.logger.warn('minecraft_connect_timeout', { host });
          try { bot.end('Connection timeout'); } catch (_) { this.scheduleReconnect(); }
        }
      }, this.config.connectTimeoutMs);
      this.connectTimer.unref?.();

      bot.on('error', (error) => {
        if (this.bot !== bot || generation !== this.generation) return;
        const msg = error && error.message ? error.message : String(error || '');
        if (
          msg.includes('bounds of the managed data') ||
          msg.includes('Attempted to read beyond') ||
          msg.includes('chunk failed to load') ||
          msg.includes('Partial packet')
        ) {
          this.logger.warn('minecraft_chunk_packet_incompatible_ignored', { error: msg });
          return;
        }
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
      this._clearAbortListener();
      if (this.bot) {
        this.cleanupSessionResources(this.bot);
        this.bot = null;
      }
      if (generation !== this.generation || this.manualStop || signal?.aborted) {
        return this.getStatus();
      }
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
    this._clearAbortListener();
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

    if (bot.inventory?.on) {
      bot.inventory.on('updateSlot', (slot) => {
        if (slot === 45 || slot === 40 || !slot) void this.fastEquipTotem(bot);
      });
    }

    bot.on('heldItemChanged', () => {
      void this.fastEquipTotem(bot);
    });

    bot.on('death', () => {
      const pos = bot.entity?.position;
      const coords = pos ? `X: ${Math.round(pos.x)}, Y: ${Math.round(pos.y)}, Z: ${Math.round(pos.z)}` : 'Không rõ';
      this.logger.warn('bot_died', { coords });
      this.emit('event', { type: 'bot_death', reason: `Bot bị chết tại tọa độ ${coords}` });
      setPhysicsEnabled(bot, true, this.logger, 'death');
    });

    // Check off-hand totem immediately on spawn
    void this.fastEquipTotem(bot);

    this.startLocationMonitor(bot, generation, host);
  }

  async fastEquipTotem(bot) {
    if (!bot || !bot.inventory || this.isEquippingTotem) return;
    const offHand = bot.inventory.slots?.[45];
    if (offHand && (offHand.name === 'totem_of_undying' || String(offHand.name).includes('totem'))) return;

    const totem = bot.inventory.items().find((i) => i && (i.name === 'totem_of_undying' || String(i.name).includes('totem')));
    if (!totem) return;

    try {
      this.isEquippingTotem = true;
      await Promise.race([
        bot.equip(totem, 'off-hand'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Equip totem timeout')), 5000))
      ]);
      if (this.bot === bot) {
        this.logger.info('totem_equipped_offhand', { bot: this.username });
      }
    } catch (err) {
      this.logger.warn('totem_equip_failed', { error: err?.message || String(err) });
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
        if (!this.auth.isAuthenticated() && now - this.lastAuthSendAt >= 1500) {
          this.lastAuthSendAt = now;
          if (prevKind === 'login') {
            this.auth.sendDirectAuth(bot, 'dn');
          } else {
            this.auth.sendDirectAuth(bot, 'login');
          }
        }
      } else if (kind === 'lobby') {
        if (prevKind === 'login') this.auth.markAuthenticated('login_area_exit');
        if (this.state !== 'entering') this.setState('entering', 'server_lobby');
        setPhysicsEnabled(bot, true, this.logger, 'kingmc_lobby');
        const now = Date.now();
        if (!this.auth.isAuthenticated() && now - this.lastAuthSendAt >= 3000) {
          this.lastAuthSendAt = now;
          this.auth.sendDirectAuth(bot, 'dn');
        }
        this.navigator.tryJoin(bot);
      } else if (kind === 'other') {
        this.auth.markAuthenticated('kingmc_world');
        setPhysicsEnabled(bot, false, this.logger, 'kingmc_world');
        if (this.state !== 'online') {
          this.setState('online', 'kingmc_in_game');
          this.emit('event', { type: 'online', host, message: 'Đã vào cụm sinh tồn KingMC' });
        }
      }
    };

    if (this.initialLocationTimer) clearTimeout(this.initialLocationTimer);
    this.initialLocationTimer = setTimeout(() => {
      this.initialLocationTimer = null;
      check();
    }, 800);
    this.initialLocationTimer.unref?.();
    this.locationTimer = setInterval(check, 1500);
    this.locationTimer.unref?.();
  }

  onMessage(bot, generation, json) {
    if (this.bot !== bot || generation !== this.generation) return;
    const text = extractChatMessage(json);
    if (!text) return;
    const safeText = redactAuditValue(text);
    this.logger.info('minecraft_message_received', { text: safeText.slice(0, 160) });
    const classification = classifyServerText(text);
    if (classification === 'maintenance') {
      if (this.state === 'maintenance') return;
      this.lastKickReason = 'Server maintenance';
      this.setState('maintenance', 'maintenance_message');
      this.emit('event', { type: 'maintenance', message: 'Server maintenance notice received.' });
      try { bot.quit('server_maintenance'); } catch (_) { try { bot.end('server_maintenance'); } catch (_) {} }
    } else if (classification === 'ip_limited' || classification === 'banned') {
      this.pauseForRestriction(classification, safeText);
    } else {
      const wasAuthenticated = this.auth.isAuthenticated();
      if (this.auth.handleMessage(bot, text)) {
        if (wasAuthenticated && !this.auth.isAuthenticated()) this.navigator.clear();
        else if (!wasAuthenticated && this.auth.isAuthenticated() && getLocationKind(bot) === 'lobby') this.navigator.tryJoin(bot);
        return;
      }
      const lower = text.toLowerCase();
      // KingMC Lobby chat detection (mc-bot.js:591-635)
      if (lower.includes('kingmc.vn')) {
        const pos = bot.entity ? bot.entity.position : null;
        let isLobby = false;
        if (pos) {
          const dx = Math.min(Math.abs(pos.x - 0.50), Math.abs(pos.x - 1.0));
          const dy = Math.abs(pos.y - 41.00);
          const dz = Math.min(Math.abs(pos.z - 0.80), Math.abs(pos.z - 1.0));
          if (dx <= 2.5 && dy <= 2.5 && dz <= 2.5) {
            isLobby = true;
          }
        }
        if (isLobby) {
          setPhysicsEnabled(bot, true, this.logger, 'kingmc_lobby_chat');
          const now = Date.now();
          if (!this.auth.isAuthenticated() && (!this.lastLobbyAuthAt || now - this.lastLobbyAuthAt > 5000)) {
            this.lastLobbyAuthAt = now;
            this.auth.sendDirectAuth(bot, 'dn');
            if (this.lobbyRoutineTimer) clearTimeout(this.lobbyRoutineTimer);
            this.lobbyRoutineTimer = setTimeout(() => {
              this.lobbyRoutineTimer = null;
              if (this.bot === bot) {
                this.navigator.triggerServerJoin(bot, 'lobby_chat_confirmed');
              }
            }, 2500);
            this.lobbyRoutineTimer.unref?.();
          }
          return;
        }
      }
    }
  }

  onKicked(bot, generation, reason) {
    if (this.bot !== bot || generation !== this.generation) return;
    const text = extractChatMessage(reason) || cleanText(typeof reason === 'string' ? reason : '');
    const safeText = redactAuditValue(text);
    this.lastKickReason = safeText.slice(0, 300);
    const isVerificationKick = isVerificationSuccessNotice(text);
    const classification = classifyServerText(text);

    this.emit('event', {
      type: 'kicked',
      reason: this.lastKickReason,
      message: this.lastKickReason
    });

    if (classification === 'ip_limited' || classification === 'banned') {
      this.pauseForRestriction(classification, safeText);
    } else if (classification === 'maintenance') {
      this.setState('maintenance', 'maintenance_kick');
    } else if (isVerificationKick) {
      this.logger.info('kingmc_verification_kick_detected', { text: this.lastKickReason });
      this.setState('error', 'verification_kick');
      this.isVerificationKickPending = true;
      this.pendingReconnectDelayMs = 2500;
    } else {
      this.setState('error', 'kicked');
    }
    try { bot.quit('kicked'); } catch (_) { try { bot.end('kicked'); } catch (_) {} }
    this.onEnd(bot, generation);
  }

  cleanupSessionResources(bot = this.bot) {
    this._clearAbortListener();
    this.clearTimers();
    this.isEquippingTotem = false;
    if (this.afk) this.afk.stop();
    if (this.monitor) this.monitor.detach();
    if (this.navigator) this.navigator.clear();
    if (this.chunkPruneTimer) {
      clearInterval(this.chunkPruneTimer);
      this.chunkPruneTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.locationTimer) {
      clearInterval(this.locationTimer);
      this.locationTimer = null;
    }
    if (bot) {
      stopEntityPruner(bot);
      try { bot.removeAllListeners?.(); bot.on?.('error', () => {}); } catch (_) {}
      try { bot._client?.removeAllListeners?.(); bot._client?.on?.('error', () => {}); } catch (_) {}
      try { bot.inventory?.removeAllListeners?.(); } catch (_) {}
      try {
        if (bot._client?.socket && bot._client.socket.listenerCount?.('error') === 0) {
          bot._client.socket.on('error', () => {});
        }
      } catch (_) {}
      let ended = false;
      if (typeof bot.quit === 'function') {
        try { bot.quit('cleanup'); ended = true; } catch (_) {}
      }
      if (!ended && typeof bot.end === 'function') {
        try { bot.end('cleanup'); ended = true; } catch (_) {}
      }
      if (!ended && typeof bot._client?.end === 'function') {
        try { bot._client.end('cleanup'); } catch (_) {}
      }
      try { bot._client?.socket?.destroy?.(); } catch (_) {}
      bot.entities = {};
      bot.players = {};
      bot.registry = null;
      bot.world = null;
      bot.blockAt = null;
    }
    this.networkSockets.clear();
    this.bot = null;
    this.connectedAt = null;
  }

  onEnd(bot, generation) {
    if (bot && bot._kbotEnded) return;
    if (bot) bot._kbotEnded = true;
    if (this.bot !== bot || generation !== this.generation) return;
    const isVerification = this.isVerificationKickPending;
    const pendingDelay = this.pendingReconnectDelayMs;
    this.isVerificationKickPending = false;
    this.pendingReconnectDelayMs = null;
    this.cleanupSessionResources(bot);
    if (this.manualStop || ['ip_limited', 'banned'].includes(this.state)) return;
    if (isMaintenanceWindow()) {
      this.maintenanceWindow = true;
      this.setState('maintenance', 'fixed_maintenance_window');
      return;
    }
    if (this.state !== 'maintenance') {
      if (!isVerification) {
        this.setState('error', 'disconnected');
        this.hostIndex = (this.hostIndex + 1) % this.config.mc.hosts.length;
      }
    }
    if (isVerification) {
      this.reconnectAttempts = 0;
    }
    const delay = isVerification ? (pendingDelay || 2500) : (this.state === 'maintenance' ? this.config.maintenanceWaitMs : undefined);
    this.scheduleReconnect(delay);
  }

  pauseForRestriction(kind, message) {
    this.restriction = kind;
    this.lastKickReason = redactAuditValue(cleanText(message)).slice(0, 300);
    this.setState(kind, kind === 'ip_limited' ? 'server_ip_limit' : 'server_ban');
    this.emit('event', { type: kind, message: this.lastKickReason });
    this.manualStop = true;
    const bot = this.bot;
    this.bot = null;
    this.cleanupSessionResources(bot);
  }

  scheduleReconnect(delayOverride) {
    if (this.manualStop || !this.config.autoReconnect || this.reconnectTimer) return;
    if (isMaintenanceWindow()) {
      this.maintenanceWindow = true;
      this.setState('maintenance', 'fixed_maintenance_window');
      return;
    }
    if (this.state !== 'maintenance') {
      if (this.reconnectAttempts >= (this.config.reconnectMaxAttempts || 25)) {
        this.logger.warn('minecraft_reconnect_limit_reached', { attempts: this.reconnectAttempts });
        this.manualStop = true;
        this.setState('error', 'max_reconnects_reached');
        return;
      }
      this.reconnectAttempts += 1;
      this.reconnectCount += 1;
    }
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

  _haltSession(reason = 'manager_stop', { emitEvent = false } = {}) {
    this._clearAbortListener();
    this.manualStop = true;
    this.generation += 1;
    this.clearTimers();
    const bot = this.bot;
    this.bot = null;
    this.cleanupSessionResources(bot);
    this.setState('stopped', reason);
    if (emitEvent) this.emit('event', { type: 'stopped', reason });
    return this.getStatus();
  }

  abortPending(reason = 'command_timeout') {
    return this._haltSession(reason, { emitEvent: false });
  }

  async stop(reason = 'manager_stop', { emitEvent = true, signal } = {}) {
    if (signal?.aborted) {
      this.abortPending(this._abortReasonFromSignal(signal));
    }
    return this._haltSession(reason, { emitEvent });
  }

  async restart({ signal } = {}) {
    if (signal?.aborted) {
      this.abortPending(this._abortReasonFromSignal(signal));
      return this.getStatus();
    }
    if (this.restriction) {
      return {
        ok: false, error: 'worker_restricted', code: 'WORKER_RESTRICTED', status: 409,
        detail: 'Worker is held by a Manager restriction and cannot restart.', worker: this.getStatus()
      };
    }
    await this.stop('manager_restart');
    if (signal?.aborted) {
      this.abortPending(this._abortReasonFromSignal(signal));
      return this.getStatus();
    }
    this.manualStop = false;
    this.reconnectAttempts = 0;
    return this.connect({ signal });
  }

  async resetData({ signal } = {}) {
    if (signal?.aborted) {
      this.abortPending(this._abortReasonFromSignal(signal));
      return { ok: false, error: 'reset_aborted', worker: this.getStatus() };
    }
    this.generation += 2;
    this._clearAbortListener();
    this.manualStop = true;
    this.clearTimers();
    const bot = this.bot;
    this.bot = null;
    this.cleanupSessionResources(bot);
    this.username = '';
    this.password = '';
    this.auth.setPassword('');
    this.reconnectAttempts = 0;
    this.reconnectCount = 0;
    this.lastError = null;
    this.lastKickReason = null;
    this.state = ['ip_limited', 'banned'].includes(this.restriction) ? this.restriction : 'stopped';
    this.lastStateAt = new Date().toISOString();
    this.emit('state', this.getStatus());
    return { ok: true, worker: this.getStatus() };
  }

  hasCredentials() {
    const isAuthRequired = Boolean(this.config.authEnabled ?? this.config.mc?.authEnabled ?? true);
    return Boolean(this.username && (!isAuthRequired || this.password));
  }

  applyManagerCredentials(credentials) {
    if (credentials === null) {
      this.username = '';
      this.password = '';
      this.auth.setPassword('');
      return true;
    }
    if (!credentials || typeof credentials !== 'object') return false;
    const username = String(credentials.username || '').trim();
    const password = String(credentials.password ?? '');
    const isAuthRequired = Boolean(this.config.authEnabled ?? this.config.mc?.authEnabled ?? true);
    if (!username || username.length > 64 || (isAuthRequired && !password) || password.length > 256) {
      throw new Error('Manager Minecraft credentials are invalid.');
    }
    this.username = username;
    this.password = password;
    this.auth.setPassword(password);
    return true;
  }

  restoreManagerState({ restricted, restriction, state } = {}) {
    const recoveredRestriction = restriction || (['ip_limited', 'banned'].includes(state) ? state : null);
    if (restricted === false && !recoveredRestriction) {
      if (['manager_check_failed', 'manager_hold'].includes(this.restriction)) {
        this.restriction = null;
        this.manualStop = true;
        this.state = 'stopped';
        this.lastStateAt = new Date().toISOString();
        this.logger.info('worker_manager_hold_cleared');
        this.emit('state', this.getStatus());
        return true;
      }
      return false;
    }
    if (!restricted && !recoveredRestriction) return false;
    this.restriction = recoveredRestriction || 'manager_hold';
    this.manualStop = true;
    this.generation += 1;
    this.clearTimers();
    const bot = this.bot;
    this.bot = null;
    this.cleanupSessionResources(bot);
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
    this.generation += 1;
    this.clearTimers();
    const bot = this.bot;
    this.bot = null;
    this.cleanupSessionResources(bot);
    this.restriction = reason;
    this.manualStop = true;
    this.state = 'stopped';
    this.lastStateAt = new Date().toISOString();
    this.logger.warn('worker_manual_resume_required', { reason });
    this.emit('state', this.getStatus());
  }

  clearManagerCheckHold() {
    if (!['manager_check_failed', 'manager_hold'].includes(this.restriction)) return false;
    this.restriction = null;
    this.manualStop = true;
    this.state = 'stopped';
    this.lastStateAt = new Date().toISOString();
    this.logger.info('worker_manager_check_recovered');
    this.emit('state', this.getStatus());
    return true;
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

  getInventorySnapshot(bot = this.bot) {
    if (!bot || !bot.inventory) {
      return {
        slots: {},
        armor: { head: null, torso: null, legs: null, feet: null },
        offhand: null,
        health: 20,
        food: 20,
        totemCount: 0,
        goldenAppleCount: 0,
        foodCount: 0,
        selectedHotbar: 0,
        revision: this.inventoryRevision,
        items: []
      };
    }
    const rawSlots = bot.inventory.slots || {};
    const slots = {};
    let totemCount = 0;
    let goldenAppleCount = 0;
    let foodCount = 0;
    const items = [];

    const FOOD_NAMES = new Set([
      'apple', 'baked_potato', 'beetroot', 'beetroot_soup', 'bread', 'carrot',
      'cooked_beef', 'cooked_chicken', 'cooked_cod', 'cooked_mutton', 'cooked_porkchop',
      'cooked_salmon', 'cooked_rabbit', 'cookie', 'golden_apple', 'enchanted_golden_apple',
      'golden_carrot', 'melon_slice', 'mushroom_stew', 'pumpkin_pie', 'rabbit_stew', 'sweet_berries'
    ]);

    for (let s = 0; s <= 45; s++) {
      const it = rawSlots[s];
      if (it && it.name) {
        slots[String(s)] = {
          slot: s,
          name: it.name,
          count: it.count,
          displayName: it.displayName || it.name
        };
        if (s !== 45) {
          if (it.name === 'totem_of_undying' || String(it.name).includes('totem')) totemCount += Number(it.count || 1);
          else if (it.name === 'golden_apple' || it.name === 'enchanted_golden_apple') goldenAppleCount += Number(it.count || 1);
          if (FOOD_NAMES.has(it.name)) foodCount += Number(it.count || 1);
          if (items.length < 36) items.push({ name: it.name, count: it.count, slot: s });
        }
      }
    }
    const off = rawSlots[45];
    if (off && (off.name === 'totem_of_undying' || String(off.name).includes('totem'))) {
      totemCount += Number(off.count || 1);
    }

    return {
      slots,
      armor: {
        head: slots['5'] || null,
        torso: slots['6'] || null,
        legs: slots['7'] || null,
        feet: slots['8'] || null
      },
      offhand: slots['45'] ? slots['45'].name : null,
      health: Number.isFinite(bot.health) ? Math.round(bot.health) : 20,
      food: Number.isFinite(bot.food) ? Math.round(bot.food) : 20,
      totemCount,
      goldenAppleCount,
      foodCount,
      selectedHotbar: Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : 0,
      revision: this.inventoryRevision,
      items
    };
  }

  setAfkMode(_value) {
    this.afkMode = 'still';
    this.afk.mode = 'still';
    return { ok: true, afkMode: 'still' };
  }

  async setProxy(value, { signal } = {}) {
    if (this.restriction) throw new Error('Proxy settings cannot be changed while the worker is on a server restriction hold.');
    const proxy = parseSocksProxy(value, 'proxy');
    const shouldReconnect = Boolean(this.bot && ['online', 'entering', 'connecting', 'authenticating'].includes(this.state));
    this.proxy = proxy;
    if (shouldReconnect && !signal?.aborted) await this.restart({ signal });
    return { ok: true, proxyEnabled: Boolean(proxy), reconnecting: shouldReconnect };
  }

  async respawn() {
    const bot = this.requireOnlineBot();
    if (typeof bot.respawn === 'function') {
      await bot.respawn();
      return { ok: true, action: 'respawn' };
    }
    return { ok: true, action: 'respawn', note: 'native respawn triggered' };
  }

  async look(yaw, pitch) {
    const bot = this.requireOnlineBot();
    const y = Number.isFinite(Number(yaw)) ? Number(yaw) : 0;
    const p = Number.isFinite(Number(pitch)) ? Number(pitch) : 0;
    if (typeof bot.look === 'function') {
      await bot.look(y, p, true);
      return { ok: true, yaw: y, pitch: p };
    }
    return { ok: true, yaw: y, pitch: p };
  }

  async toss(payload = {}) {
    const bot = this.requireOnlineBot();
    const rawSlot = payload.slot ?? payload.sourceSlot;
    const slot = rawSlot !== undefined && rawSlot !== null && String(rawSlot).trim() !== '' ? Number(rawSlot) : NaN;
    if (Number.isInteger(slot) && slot >= 0 && slot <= 45 && bot.inventory?.slots?.[slot]) {
      const item = bot.inventory.slots[slot];
      if (typeof bot.tossStack === 'function') {
        await bot.tossStack(item);
        this.inventoryRevision += 1;
        return { ok: true, tossedSlot: slot, item: item.name, inventory: this.getInventorySnapshot(bot) };
      }
    }
    if (typeof bot.toss === 'function' && payload.itemType) {
      await bot.toss(payload.itemType, payload.metadata || null, payload.count || 1);
      this.inventoryRevision += 1;
      return { ok: true, tossed: payload.itemType, inventory: this.getInventorySnapshot(bot) };
    }
    return { ok: true, note: 'toss_executed_or_empty_slot', inventory: this.getInventorySnapshot(bot) };
  }

  async handleInventory(payload = {}) {
    const bot = this.requireOnlineBot();
    const action = String(payload.action || 'list').toLowerCase();

    if (payload.revision !== undefined && payload.revision !== null && Number.isInteger(Number(payload.revision))) {
      if (Number(payload.revision) !== this.inventoryRevision) {
        return {
          ok: false,
          error: 'inventory_revision_mismatch',
          status: 409,
          inventory: this.getInventorySnapshot(bot)
        };
      }
    }

    if (action === 'list') {
      const snapshot = this.getInventorySnapshot(bot);
      return {
        ok: true,
        items: snapshot.items,
        inventory: snapshot
      };
    }

    if (action === 'move') {
      const rawSrc = payload.sourceSlot ?? payload.slot;
      const rawDst = payload.destSlot ?? payload.targetSlot;
      const src = rawSrc !== undefined && rawSrc !== null && String(rawSrc).trim() !== '' ? Number(rawSrc) : NaN;
      const dst = rawDst !== undefined && rawDst !== null && String(rawDst).trim() !== '' ? Number(rawDst) : NaN;
      if (!Number.isInteger(src) || !Number.isInteger(dst) || src < 0 || dst < 0) {
        throw new Error('Valid sourceSlot and destSlot numbers required.');
      }
      if (src === dst) {
        return { ok: true, action: 'move', moved: false, inventory: this.getInventorySnapshot(bot) };
      }
      if (typeof bot.moveSlotItem === 'function') {
        await bot.moveSlotItem(src, dst);
      } else if (typeof bot.clickWindow === 'function') {
        await bot.clickWindow(src, 0, 0);
        await bot.clickWindow(dst, 0, 0);
      }
      this.inventoryRevision += 1;
      return {
        ok: true,
        action: 'move',
        sourceSlot: src,
        destSlot: dst,
        inventory: this.getInventorySnapshot(bot)
      };
    }

    if (action === 'equip' || action === 'wear') {
      const rawSlot = payload.slot ?? payload.sourceSlot;
      const slot = rawSlot !== undefined && rawSlot !== null && String(rawSlot).trim() !== '' ? Number(rawSlot) : NaN;
      const dest = String(payload.destination || 'hand');
      const item = (Number.isInteger(slot) ? bot.inventory?.slots?.[slot] : null) ||
        bot.inventory?.items?.().find(i => i.name === payload.item);
      if (item && typeof bot.equip === 'function') {
        await bot.equip(item, dest);
        this.inventoryRevision += 1;
        return { ok: true, equipped: item.name, destination: dest, inventory: this.getInventorySnapshot(bot) };
      }
      return { ok: true, destination: dest, note: 'item_or_slot_empty', inventory: this.getInventorySnapshot(bot) };
    }

    if (action === 'unequip') {
      const dest = String(payload.destination || 'hand');
      const beforeSlots = new Set();
      for (let s = 9; s <= 44; s++) {
        if (bot.inventory?.slots?.[s]) beforeSlots.add(s);
      }
      if (typeof bot.unequip === 'function') {
        await bot.unequip(dest);
      }
      let unequippedToSlot = null;
      for (let s = 9; s <= 44; s++) {
        if (bot.inventory?.slots?.[s] && !beforeSlots.has(s)) {
          unequippedToSlot = s;
          break;
        }
      }
      this.inventoryRevision += 1;
      return {
        ok: true,
        action: 'unequip',
        destination: dest,
        unequippedToSlot,
        inventory: this.getInventorySnapshot(bot)
      };
    }

    if (action === 'drop') {
      return this.toss(payload);
    }

    if (action === 'select') {
      const rawSlot = payload.slot;
      const slot = rawSlot !== undefined && rawSlot !== null && String(rawSlot).trim() !== '' ? Number(rawSlot) : NaN;
      if (Number.isInteger(slot) && slot >= 0 && slot <= 8 && typeof bot.setQuickBarSlot === 'function') {
        bot.setQuickBarSlot(slot);
        this.inventoryRevision += 1;
        return { ok: true, quickBarSlot: slot, inventory: this.getInventorySnapshot(bot) };
      }
      return { ok: true, selected: slot, inventory: this.getInventorySnapshot(bot) };
    }

    return { ok: true, action, inventory: this.getInventorySnapshot(bot) };
  }

  async clickWindow(payload = {}) {
    const bot = this.requireOnlineBot();
    const window = bot.currentWindow;
    if (!window) return { ok: false, error: 'no_open_window' };
    const rawSlot = payload.slot;
    const slot = rawSlot !== undefined && rawSlot !== null && String(rawSlot).trim() !== '' ? Number(rawSlot) : NaN;
    const mouseButton = Number(payload.mouseButton ?? 0);
    const mode = Number(payload.mode ?? 0);
    if (!Number.isInteger(slot)) throw new Error('Valid slot number required.');
    if (typeof bot.clickWindow === 'function') {
      await bot.clickWindow(slot, mouseButton, mode);
      this.inventoryRevision += 1;
      return { ok: true, clickedSlot: slot, inventory: this.getInventorySnapshot(bot) };
    }
    return { ok: true, clickedSlot: slot, note: 'click_registered', inventory: this.getInventorySnapshot(bot) };
  }

  async closeWindow() {
    const bot = this.requireOnlineBot();
    const window = bot.currentWindow;
    if (window && typeof bot.closeWindow === 'function') {
      bot.closeWindow(window);
      return { ok: true, closed: true };
    }
    return { ok: true, closed: false, note: 'no_window_open' };
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
      if (socket.destroyed) this.networkSockets.delete(socket);
    }
    const elapsedSeconds = Math.max(0.1, (now - this.networkSampleAt) / 1000);
    this.bandwidthRxBps = received / elapsedSeconds;
    this.bandwidthTxBps = sent / elapsedSeconds;
    this.networkSampleAt = now;
  }

  pruneMemory() {
    if (this.bot) {
      if (this.bot.entities) {
        for (const id in this.bot.entities) {
          if (this.bot.entities[id] !== this.bot.entity) {
            delete this.bot.entities[id];
          }
        }
      }
      if (this.bot.players) {
        for (const p in this.bot.players) {
          if (p !== this.bot.username) {
            delete this.bot.players[p];
          }
        }
      }
    }
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
    if (bot) {
      this.cleanupSessionResources(bot);
    }
    this.bot = null;
    this.connectedAt = null;
    this.setState('maintenance', 'fixed_maintenance_window');
    this.emit('event', { type: 'maintenance_window', message: 'Scheduled stop 04:30–05:30 Vietnam time (UTC+7).' });
  }

  recordChat(bot, username, message) {
    if (this.bot !== bot || username === bot.username) return;
    const clean = redactAuditValue(cleanText(message).replace(/[\r\n\t]+/g, ' ')).slice(0, 240);
    if (!clean) return;
    this.emit('event', { type: 'chat', message: `[${String(username || 'player').slice(0, 40)}] ${clean}` });
  }

  clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.locationTimer) clearInterval(this.locationTimer);
    if (this.initialLocationTimer) clearTimeout(this.initialLocationTimer);
    if (this.lobbyRoutineTimer) clearTimeout(this.lobbyRoutineTimer);
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.locationTimer = null;
    this.initialLocationTimer = null;
    this.lobbyRoutineTimer = null;
  }

  getStatus() {
    const invSnapshot = this.getInventorySnapshot(this.bot);
    const monitorSnap = this.monitor.snapshot();
    return {
      workerId: this.config.workerId, transport: this.config.transport, state: this.state,
      locationKind: this.lastLocationKind,
      locationState: this.lastLocationKind,
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
      ...monitorSnap,
      inventory: invSnapshot,
      items: monitorSnap.inventory,
      lastError: this.lastError, lastKickReason: this.lastKickReason, lastStateAt: this.lastStateAt
    };
  }
}

module.exports = { MinecraftSession, classifyServerText };

