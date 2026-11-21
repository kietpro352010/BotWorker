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

const FOOD_ITEM_NAMES = new Set([
  'apple', 'baked_potato', 'beetroot', 'beetroot_soup', 'bread', 'carrot',
  'cooked_beef', 'cooked_chicken', 'cooked_cod', 'cooked_mutton', 'cooked_porkchop',
  'cooked_salmon', 'cooked_rabbit', 'cookie', 'golden_apple', 'enchanted_golden_apple',
  'golden_carrot', 'melon_slice', 'mushroom_stew', 'pumpkin_pie', 'rabbit_stew', 'sweet_berries'
]);

function getVietnamClockParts(date = new Date()) {
  const vnDate = new Date(date.getTime() + 7 * 3600 * 1000);
  const yyyy = vnDate.getUTCFullYear();
  const mm = String(vnDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(vnDate.getUTCDate()).padStart(2, '0');
  const hh = String(vnDate.getUTCHours()).padStart(2, '0');
  const min = String(vnDate.getUTCMinutes()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  return {
    dateStr,
    hhmm: `${hh}:${min}`,
    dateMinKey: `${dateStr} ${hh}:${min}`,
    minuteOfDay: vnDate.getUTCHours() * 60 + vnDate.getUTCMinutes(),
    dayOfWeek: vnDate.getUTCDay()
  };
}

function applyCommandJitterMs(baseMs, maxOffsetMs = 5000, minFloorMs = 600) {
  const base = Math.max(0, Number(baseMs) || 0);
  const offset = Math.floor((Math.random() * 2 - 1) * maxOffsetMs);
  return Math.max(minFloorMs, base + offset);
}

function applyScheduleJitterMs(baseMinutes, maxOffsetMinutes = 15, minFloorMs = 60000) {
  const baseMs = Math.max(1, Math.min(43200, Number(baseMinutes) || 120)) * 60 * 1000;
  const maxOffsetMs = Math.min(maxOffsetMinutes * 60 * 1000, Math.floor(baseMs * 0.75));
  const offsetMs = Math.floor((Math.random() * 2 - 1) * maxOffsetMs);
  return Math.max(minFloorMs, baseMs + offsetMs);
}

function parseHhmmToMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatMinutesToHhmm(totalMinutes) {
  const wrapped = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

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
    this.consecutiveHostFailures = 0;
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
    this.ecoMode = true;
    this.autoTotem = true;
    this.antiHungry = true;
    this.autoReconnect = Boolean(config.autoReconnect ?? true);
    this.antiAfkKick = true;
    this.spawnCommands = '';
    this.autoChatSchedules = [];
    this.botSchedules = [];
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
    this.isEatingFood = false;
    this.spawnCommandTimers = new Set();
    this.autoChatTimer = null;
    this.autoChatDelayTimers = new Set();
    this.autoChatLastIntervalAt = new Map();
    this.autoChatNextIntervalAt = new Map();
    this.autoChatLastFixedKey = new Map();
    this.botScheduleTimer = null;
    this.botScheduleLastFixedKey = new Map();
    this.botScheduleDailyJitter = new Map();
    this.botScheduleCycleState = null;
    this._autoChatSchedulesSig = '';
    this._botSchedulesSig = '';
    this.isInAfkState = false;
    this.wasAfkBeforeDisconnect = false;
    this.lastReconnectAttemptCount = 0;
    this.maxReconnectAttempts = Number(config.reconnectMaxAttempts) || 8;
    this.nextAuthAllowedAt = 0;
    this.inventoryRevision = 0;
    this.inventoryUpdateTimer = null;
    this.lastInventoryStateEmitAt = 0;
    this.windowRevision = 0;
    this.isVerificationKickPending = false;
    this.pendingReconnectDelayMs = null;
    this.recentChatSignatures = new Set();
    this.hostPublicIp = null;
    void this.resolvePublicIp();
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
    if (!this.maintenanceTimer) this.scheduleMaintenanceBoundary();
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

  _getHosts() {
    const configured = this.config?.mc?.hosts;
    if (Array.isArray(configured) && configured.length > 0) return configured;
    if (this.config?.mc?.host) return [this.config.mc.host];
    return ['kingmc.vn', 'sgp.kingmc.vn'];
  }

  _getCurrentHost() {
    const hosts = this._getHosts();
    return hosts[this.hostIndex % hosts.length] || 'kingmc.vn';
  }

  _recordHostFailure(currentHost) {
    this.consecutiveHostFailures = (this.consecutiveHostFailures || 0) + 1;
    const hosts = this._getHosts();
    if (hosts.length > 1 && this.consecutiveHostFailures >= 3) {
      const prevHost = hosts[this.hostIndex % hosts.length];
      this.hostIndex = (this.hostIndex + 1) % hosts.length;
      const nextHost = hosts[this.hostIndex % hosts.length];
      this.consecutiveHostFailures = 0;
      this.logger.info('minecraft_host_switched_after_3_failures', { fromHost: prevHost, toHost: nextHost });
      this.emit('event', {
        type: 'host_switch',
        message: `Máy chủ ${prevHost} không phản hồi sau 3 lần kết nối liên tục. Tự động chuyển sang ${nextHost}.`
      });
    } else {
      this.logger.info('minecraft_host_failure_recorded', {
        host: currentHost,
        consecutiveHostFailures: this.consecutiveHostFailures
      });
    }
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
    this.auth.enabled = Boolean(this.config.authEnabled ?? this.config.mc?.authEnabled ?? true);
    this.auth.reset();
    this.state = 'connecting';
    this.lastStateAt = new Date().toISOString();
    const host = this._getCurrentHost();
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
    this.emit('event', {
      type: 'connecting',
      message: `Đang kết nối đến máy chủ ${host}:${this.config.mc.port}...`
    });
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
        fakeHost: host || 'kingmc.vn',
        auth: this.config.mc.authType === 'microsoft' ? 'microsoft' : 'offline',
        plugins: DISABLED_PLUGINS
      };
      if (this.proxy) {
        delete options.host;
        options.fakeHost = host || 'kingmc.vn';
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
          try { bot.end('Connection timeout'); } catch (_) {}
          if (this.bot === bot && generation === this.generation && !bot._kbotEnded) {
            this.onEnd(bot, generation);
          }
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
      bot.on('windowOpen', (win) => {
        this.windowRevision = (this.windowRevision || 0) + 1;
        const title = typeof win?.title === 'object' ? (win.title.text || win.title.value || '') : (win?.title || '');
        this.logger.info('window_opened', { title, type: win?.type });
        this.emit('event', { type: 'window_open', title, windowType: win?.type });
        if (win && typeof win.on === 'function') {
          win.on('updateSlot', () => {
            this.windowRevision = (this.windowRevision || 0) + 1;
          });
        }
      });
      bot.on('windowClose', (win) => {
        this.windowRevision = (this.windowRevision || 0) + 1;
        this.logger.info('window_closed', { type: win?.type });
        this.emit('event', { type: 'window_close' });
      });
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
      this._recordHostFailure(host);
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
    this.consecutiveHostFailures = 0;
    this.connectedAt = Date.now();
    this.lastError = null;
    this.setState('entering', 'minecraft_spawn');
    this.emit('event', {
      type: 'spawn',
      message: `Bot đã kết nối thành công và xuất hiện tại máy chủ ${host || this._getCurrentHost()}.`
    });
    this.monitor.attach(bot);
    if (this.ecoMode !== false) {
      applyEcoPhysics(bot);
      if (this.chunkPruneTimer) clearInterval(this.chunkPruneTimer);
      this.chunkPruneTimer = startChunkPruner(bot, { intervalMs: 30000, radius: 2 });
    }
    this.navigator.onSpawn(bot);
    this.afk.mode = this.afkMode;
    if (this.antiAfkKick !== false) {
      this.afk.start(bot);
    }

    // Auto Totem & Health / Death / Anti-Hungry monitoring
    bot._client?.on?.('entity_status', (packet) => {
      if (packet && packet.entityId === bot.entity?.id && packet.entityStatus === 35) {
        this.logger.info('totem_popped', { bot: this.username });
        this.emit('event', { type: 'totem_popped', message: 'Totem vừa phát nổ cứu mạng bot! Đang lắp Totem mới vào tay phụ...' });
        void this.fastEquipTotem(bot);
      }
    });

    bot.on('health', () => {
      if (bot.health <= 10) void this.fastEquipTotem(bot);
      if (typeof bot.food === 'number' && bot.food < 16) void this.tryEatFood(bot);
    });

    if (bot.inventory?.on) {
      bot.inventory.on('updateSlot', (slot) => {
        if (slot === 45 || slot === 40 || !slot) void this.fastEquipTotem(bot);
        this.scheduleInventoryRevisionBump(bot);
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

    bot.on('respawn', () => {
      this.logger.info('bot_respawned', { bot: this.username });
      this.emit('event', { type: 'respawn', message: 'Bot đã hồi sinh (respawn).' });
    });

    // Check off-hand totem immediately on spawn
    void this.fastEquipTotem(bot);

    this.startLocationMonitor(bot, generation, host);
    this.startAutoChatLoop(bot, generation);
  }

  scheduleInventoryRevisionBump(bot) {
    if (this.bot !== bot || this.manualStop) return;
    if (this.inventoryUpdateTimer) clearTimeout(this.inventoryUpdateTimer);
    this.inventoryUpdateTimer = setTimeout(() => {
      this.inventoryUpdateTimer = null;
      if (this.bot !== bot || this.manualStop) return;
      this.inventoryRevision += 1;
      const now = Date.now();
      if (now - this.lastInventoryStateEmitAt >= 2000) {
        this.lastInventoryStateEmitAt = now;
        this.emit('state', this.getStatus());
      }
    }, 350);
    this.inventoryUpdateTimer.unref?.();
  }

  async fastEquipTotem(bot) {
    if (!bot || !bot.inventory || bot.currentWindow || this.isEquippingTotem || this.isEatingFood || this.autoTotem === false) return;
    const offHand = bot.inventory.slots?.[45];
    if (offHand && (offHand.name === 'totem_of_undying' || String(offHand.name).includes('totem'))) return;

    const totem = bot.inventory.items().find((i) => i && (i.name === 'totem_of_undying' || String(i.name).includes('totem')));
    if (!totem) return;

    let equipTimer = null;
    try {
      this.isEquippingTotem = true;
      const equipPromise = Promise.resolve().then(() => bot.equip(totem, 'off-hand'));
      equipPromise.catch(() => {});
      await Promise.race([
        equipPromise,
        new Promise((_, reject) => {
          equipTimer = setTimeout(() => reject(new Error('Equip totem timeout')), 5000);
          equipTimer.unref?.();
        })
      ]);
      if (this.bot === bot) {
        this.logger.info('totem_equipped_offhand', { bot: this.username });
      }
    } catch (err) {
      this.logger.warn('totem_equip_failed', { error: err?.message || String(err) });
      } finally {
      if (equipTimer) clearTimeout(equipTimer);
      if (this.bot === bot || !this.bot) {
        this.isEquippingTotem = false;
      }
    }
  }

  async tryEatFood(bot) {
    if (!bot || !bot.inventory || bot.currentWindow || this.antiHungry === false || this.isEatingFood || this.isEquippingTotem) return;
    if (this.state !== 'online' || typeof bot.food !== 'number' || bot.food >= 16) return;
    if (typeof bot.equip !== 'function' || typeof bot.consume !== 'function') return;

    const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
    const allowGap = typeof bot.health === 'number' && bot.health <= 12;
    const food = items.find((i) => i && FOOD_ITEM_NAMES.has(i.name) && (allowGap || (i.name !== 'golden_apple' && i.name !== 'enchanted_golden_apple')))
      || (allowGap ? items.find((i) => i && FOOD_ITEM_NAMES.has(i.name)) : null);
    if (!food) return;

    let eatTimer = null;
    try {
      this.isEatingFood = true;
      const eatPromise = Promise.resolve().then(async () => {
        await bot.equip(food, 'hand');
        await bot.consume();
      });
      eatPromise.catch(() => {});
      await Promise.race([
        eatPromise,
        new Promise((_, reject) => {
          eatTimer = setTimeout(() => reject(new Error('Consume food timeout')), 4500);
          eatTimer.unref?.();
        })
      ]);
      if (this.bot === bot) {
        this.logger.info('food_consumed', { bot: this.username, item: food.name });
      }
    } catch (err) {
      this.logger.debug?.('food_consume_failed', { error: err?.message || String(err) });
    } finally {
      if (eatTimer) clearTimeout(eatTimer);
      if (this.bot === bot || !this.bot) {
        this.isEatingFood = false;
      }
    }
  }

  runSpawnCommands(bot, generation) {
    for (const t of this.spawnCommandTimers) clearTimeout(t);
    this.spawnCommandTimers.clear();
    const raw = String(this.spawnCommands || '').trim();
    if (!raw || !bot || typeof bot.chat !== 'function') return;
    const cmds = raw.split(/[\r\n;]+/).map((line) => line.trim()).filter((line) => line.length > 0 && line.length <= 256 && !isRestrictedMinecraftCommand(line)).slice(0, 15);
    let prevDelayMs = 0;
    cmds.forEach((cmd, idx) => {
      // Base milestone: (idx + 1) * 5000ms with ±5000ms anti-cheat jitter, strictly ordered
      const jittered = applyCommandJitterMs((idx + 1) * 5000, 5000, 800);
      const delayMs = Math.max(prevDelayMs + 800, jittered);
      prevDelayMs = delayMs;
      const timer = setTimeout(() => {
        this.spawnCommandTimers.delete(timer);
        if (this.bot !== bot || generation !== this.generation || this.manualStop || this.state !== 'online') return;
        try {
          bot.chat(cmd);
          this.emit('event', { type: 'chat', message: `[${bot.username || this.username}] ${cmd}` });
        } catch (_) {}
      }, delayMs);
      timer.unref?.();
      this.spawnCommandTimers.add(timer);
    });
  }

  dispatchScheduledMessages(bot, generation, messages, delaySeconds = 2) {
    if (!Array.isArray(messages) || !messages.length || !bot || typeof bot.chat !== 'function') return;
    const stepMs = Math.max(0, Math.min(3600, Number(delaySeconds) || 0)) * 1000;
    let prevDelayMs = 0;
    messages.slice(0, 20).forEach((rawMsg, idx) => {
      const msg = String(rawMsg || '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
      if (!msg || msg.length > 256 || isRestrictedMinecraftCommand(msg)) return;
      const sendNow = () => {
        if (this.bot !== bot || generation !== this.generation || this.manualStop || this.state !== 'online') return;
        try {
          bot.chat(msg);
          this.emit('event', { type: 'chat', message: `[${bot.username || this.username}] ${msg}` });
        } catch (_) {}
      };
      if (idx === 0 || stepMs === 0) {
        sendNow();
      } else {
        const jittered = applyCommandJitterMs(idx * stepMs, 5000, 500);
        const delayMs = Math.max(prevDelayMs + 500, jittered);
        prevDelayMs = delayMs;
        const timer = setTimeout(() => {
          this.autoChatDelayTimers.delete(timer);
          sendNow();
        }, delayMs);
        timer.unref?.();
        this.autoChatDelayTimers.add(timer);
      }
    });
  }

  startAutoChatLoop(bot, generation) {
    if (this.autoChatTimer) clearInterval(this.autoChatTimer);
    this.autoChatTimer = setInterval(() => {
      if (this.bot !== bot || generation !== this.generation || this.manualStop) {
        if (this.autoChatTimer) clearInterval(this.autoChatTimer);
        this.autoChatTimer = null;
        return;
      }
      if (this.state !== 'online' || !Array.isArray(this.autoChatSchedules) || !this.autoChatSchedules.length) return;
      const now = Date.now();
      const { hhmm, dateMinKey } = getVietnamClockParts(new Date(now));
      for (const s of this.autoChatSchedules) {
        if (!s || s.enabled === false) continue;
        const msgs = Array.isArray(s.messages) && s.messages.length
          ? s.messages
          : (s.message ? [s.message] : []);
        if (!msgs.length) continue;
        const schedId = String(s.id || msgs[0]);
        if (s.mode === 'fixed') {
          const times = Array.isArray(s.times) && s.times.length ? s.times : (s.time ? [s.time] : []);
          if (times.includes(hhmm) && this.autoChatLastFixedKey.get(schedId) !== dateMinKey) {
            this.autoChatLastFixedKey.set(schedId, dateMinKey);
            this.dispatchScheduledMessages(bot, generation, msgs, s.messageDelaySeconds);
          }
        } else {
          const baseIntervalMs = Math.max(10, Math.min(604800, Number(s.intervalSeconds) || 3600)) * 1000;
          if (!this.autoChatLastIntervalAt.has(schedId) || !this.autoChatNextIntervalAt.has(schedId)) {
            const anchorAt = this.autoChatLastIntervalAt.get(schedId) || this.connectedAt || now;
            this.autoChatLastIntervalAt.set(schedId, anchorAt);
            this.autoChatNextIntervalAt.set(schedId, anchorAt + applyCommandJitterMs(baseIntervalMs, 5000, 5000));
          } else if (now >= this.autoChatNextIntervalAt.get(schedId)) {
            this.autoChatLastIntervalAt.set(schedId, now);
            this.autoChatNextIntervalAt.set(schedId, now + applyCommandJitterMs(baseIntervalMs, 5000, 5000));
            this.dispatchScheduledMessages(bot, generation, msgs, s.messageDelaySeconds);
          }
        }
      }
    }, 2000);
    this.autoChatTimer.unref?.();
  }

  executeScheduledBotAction(action, commandText = '') {
    const act = String(action || '').toLowerCase();
    if (act === 'stop') {
      if (!this.manualStop) {
        void this.stop('scheduled_stop');
      }
    } else if (act === 'start') {
      if (this.manualStop && !this.restriction && this.hasCredentials()) {
        void this.start();
      }
    } else if (act === 'restart' || act === 'reconnect') {
      if (!this.restriction && this.hasCredentials()) {
        void this.restart();
      }
    } else if (act === 'command' || act === 'chat') {
      const cmd = String(commandText || '').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
      if (cmd && cmd.length <= 256 && !isRestrictedMinecraftCommand(cmd) && this.state === 'online' && this.bot) {
        try {
          this.bot.chat(cmd);
          this._recordChatMessage(`→ ${cmd}`, 'scheduled_chat');
        } catch (_) {}
      }
    }
  }

  resolveDailyJitteredHhmm(scheduleKey, baseHhmm, dateStr, currentMinOfDay) {
    const baseMin = parseHhmmToMinutes(baseHhmm);
    if (baseMin === null) return baseHhmm;
    const cacheKey = `${dateStr}:${scheduleKey}:${baseHhmm}`;
    let cached = this.botScheduleDailyJitter.get(cacheKey);
    if (!cached) {
      // ±15 minutes random anti-cheat offset around configured fixed schedule time, clamped to same day [00:00, 23:59]
      let minOffset = Math.max(-15, -baseMin);
      const maxOffset = Math.min(15, 1439 - baseMin);
      if (Number.isInteger(currentMinOfDay) && baseMin >= currentMinOfDay && baseMin + minOffset < currentMinOfDay) {
        // Clamp lower bound so newly created/booted schedule near target time still runs today
        minOffset = Math.min(maxOffset, Math.max(minOffset, currentMinOfDay - baseMin));
      }
      const span = Math.max(1, maxOffset - minOffset + 1);
      const offsetMin = minOffset + Math.floor(Math.random() * span);
      const effectiveMin = Math.max(0, Math.min(1439, baseMin + offsetMin));
      const effectiveHhmm = formatMinutesToHhmm(effectiveMin);
      cached = { effectiveHhmm, offsetMin };
      if (this.botScheduleDailyJitter.size > 200) {
        this.botScheduleDailyJitter.clear();
      }
      this.botScheduleDailyJitter.set(cacheKey, cached);
      this.logger?.info?.('bot_schedule_daily_jitter_assigned', {
        scheduleKey,
        baseTime: baseHhmm,
        effectiveTime: effectiveHhmm,
        offsetMinutes: offsetMin
      });
    }
    return cached.effectiveHhmm;
  }

  syncBotScheduleLoop() {
    const schedules = Array.isArray(this.botSchedules) ? this.botSchedules : [];
    const hasActive = schedules.some((s) => s && s.enabled !== false && (Array.isArray(s.items) ? s.items.length > 0 : Boolean(s.time)));
    if (!hasActive) {
      if (this.botScheduleTimer) {
        clearInterval(this.botScheduleTimer);
        this.botScheduleTimer = null;
      }
      this.botScheduleCycleState = null;
      return;
    }

    const first = schedules[0];
    if (first && first.mode === 'cycle' && Array.isArray(first.items) && first.items.length > 0) {
      const sig = JSON.stringify(first.items);
      if (!this.botScheduleCycleState || this.botScheduleCycleState.sig !== sig) {
        const firstWaitMs = applyScheduleJitterMs(first.items[0]?.afterMinutes || 120, 15, 60000);
        this.botScheduleCycleState = {
          sig,
          index: 0,
          stepStartedAt: Date.now(),
          targetWaitMs: firstWaitMs
        };
      }
    } else {
      this.botScheduleCycleState = null;
    }

    if (this.botScheduleTimer) return;
    this.botScheduleTimer = setInterval(() => {
      const list = Array.isArray(this.botSchedules) ? this.botSchedules : [];
      if (!list.length) return;
      const now = Date.now();
      const { dateStr, hhmm, dateMinKey, minuteOfDay, dayOfWeek } = getVietnamClockParts(new Date(now));

      for (const s of list) {
        if (!s || s.enabled === false) continue;
        if (Array.isArray(s.items)) {
          if (s.mode === 'cycle' && this.botScheduleCycleState && s.items.length > 0) {
            const idx = this.botScheduleCycleState.index % s.items.length;
            const item = s.items[idx];
            const waitMs = Number(this.botScheduleCycleState.targetWaitMs)
              || applyScheduleJitterMs(item?.afterMinutes || 120, 15, 60000);
            if (now - this.botScheduleCycleState.stepStartedAt >= waitMs) {
              const nextIdx = (idx + 1) % s.items.length;
              const nextItem = s.items[nextIdx];
              this.botScheduleCycleState.index = nextIdx;
              this.botScheduleCycleState.stepStartedAt = now;
              this.botScheduleCycleState.targetWaitMs = applyScheduleJitterMs(nextItem?.afterMinutes || 120, 15, 60000);
              this.executeScheduledBotAction(item.action, item.command);
            }
          } else {
            for (const item of s.items) {
              if (!item || !item.time) continue;
              const key = `${s.id || 'sched'}:${item.id || item.time}:${item.action}`;
              const effectiveHhmm = s.disableJitter
                ? item.time
                : this.resolveDailyJitteredHhmm(key, item.time, dateStr, minuteOfDay);
              if (effectiveHhmm !== hhmm) continue;
              const dayExecutionKey = `${dateStr}:${item.time}:${key}`;
              if (this.botScheduleLastFixedKey.get(key) !== dayExecutionKey) {
                if (this.botScheduleLastFixedKey.size > 200) this.botScheduleLastFixedKey.clear();
                this.botScheduleLastFixedKey.set(key, dayExecutionKey);
                this.executeScheduledBotAction(item.action, item.command);
              }
            }
          }
        } else if (s.time) {
          const allowedDays = Array.isArray(s.days) ? s.days : [0, 1, 2, 3, 4, 5, 6];
          if (!allowedDays.includes(dayOfWeek)) continue;
          const key = `flat:${s.id || s.time}:${s.action}`;
          const effectiveHhmm = s.disableJitter
            ? s.time
            : this.resolveDailyJitteredHhmm(key, s.time, dateStr, minuteOfDay);
          if (effectiveHhmm !== hhmm) continue;
          const dayExecutionKey = `${dateStr}:${s.time}:${key}`;
          if (this.botScheduleLastFixedKey.get(key) !== dayExecutionKey) {
            if (this.botScheduleLastFixedKey.size > 200) this.botScheduleLastFixedKey.clear();
            this.botScheduleLastFixedKey.set(key, dayExecutionKey);
            this.executeScheduledBotAction(s.action, s.command || s.message);
          }
        }
      }
    }, 5000);
    this.botScheduleTimer.unref?.();
  }

  startLocationMonitor(bot, generation, host) {
    if (this.locationTimer) clearInterval(this.locationTimer);
    this.lastLocationKind = 'unknown';
    this.nextAuthAllowedAt = Date.now() + applyCommandJitterMs(3000, 5000, 800);

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
        if (!this.auth.isAuthenticated() && now >= this.nextAuthAllowedAt && now - this.lastAuthSendAt >= 1500) {
          this.lastAuthSendAt = now;
          this.nextAuthAllowedAt = now + applyCommandJitterMs(5000, 5000, 1500);
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
        if (!this.auth.isAuthenticated() && now >= this.nextAuthAllowedAt && now - this.lastAuthSendAt >= 3000) {
          this.lastAuthSendAt = now;
          this.nextAuthAllowedAt = now + applyCommandJitterMs(5500, 5000, 2000);
          this.auth.sendDirectAuth(bot, 'dn');
        }
        this.navigator.tryJoin(bot);
      } else if (kind === 'other') {
        this.auth.markAuthenticated('kingmc_world');
        setPhysicsEnabled(bot, this.ecoMode === false, this.logger, 'kingmc_world');
        if (this.state !== 'online') {
          const recoveredFromAfkDrop = this.wasAfkBeforeDisconnect;
          const attemptsTaken = Math.max(1, this.lastReconnectAttemptCount || 1);
          this.isInAfkState = true;
          this.wasAfkBeforeDisconnect = false;
          this.lastReconnectAttemptCount = 0;
          this.setState('online', 'kingmc_in_game');
          this.emit('event', { type: 'online', host, message: 'Đã vào cụm sinh tồn KingMC' });
          if (recoveredFromAfkDrop) {
            this.emit('event', {
              type: 'afk_recovered',
              host,
              attempts: attemptsTaken,
              message: `Bot đã tự kết nối lại và vào lại khu vực AFK thành công (sau ${attemptsTaken} lần thử).`
            });
          }
          this.runSpawnCommands(bot, generation);
          if (typeof bot.food === 'number' && bot.food < 16) void this.tryEatFood(bot);
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
            const menuDelayMs = applyCommandJitterMs(5000, 5000, 1200);
            this.lobbyRoutineTimer = setTimeout(() => {
              this.lobbyRoutineTimer = null;
              if (this.bot === bot) {
                this.navigator.triggerServerJoin(bot, 'lobby_chat_confirmed');
              }
            }, menuDelayMs);
            this.lobbyRoutineTimer.unref?.();
          }
          return;
        }
      }
      this._recordChatMessage(safeText, 'chat');
    }
  }

  onKicked(bot, generation, reason) {
    if (this.bot !== bot || generation !== this.generation) return;
    const text = extractChatMessage(reason) || cleanText(typeof reason === 'string' ? reason : '');
    const safeText = redactAuditValue(text);
    this.lastKickReason = safeText.slice(0, 300);
    const isVerificationKick = isVerificationSuccessNotice(text);
    const classification = classifyServerText(text);
    const wasInAfk = this.isInAfkState === true && !this.manualStop && !isVerificationKick;

    const briefKick = this.lastKickReason ? this.lastKickReason.slice(0, 120) : 'Không rõ lý do';
    this.emit('event', {
      type: 'kicked',
      reason: briefKick,
      message: `Ngắt kết nối khỏi máy chủ: ${briefKick}`,
      details: { kickReason: this.lastKickReason, rawReason: typeof reason === 'string' ? reason : undefined }
    });

    if (wasInAfk) {
      this.isInAfkState = false;
      this.wasAfkBeforeDisconnect = true;
      this.emit('event', {
        type: 'afk_kicked',
        reason: briefKick,
        message: `Bot đang treo AFK thì bị ngắt kết nối: ${briefKick}`,
        details: { kickReason: this.lastKickReason, rawReason: typeof reason === 'string' ? reason : undefined }
      });
    }

    if (classification === 'ip_limited' || classification === 'banned') {
      this.pauseForRestriction(classification, safeText);
    } else if (classification === 'maintenance') {
      this.setState('maintenance', 'maintenance_kick');
    } else if (isVerificationKick) {
      this.logger.info('kingmc_verification_kick_detected', { text: this.lastKickReason });
      this.setState('error', 'verification_kick');
      this.isVerificationKickPending = true;
      this.pendingReconnectDelayMs = applyCommandJitterMs(4500, 5000, 1500);
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
      bot._kbotEnded = true;
      bot.physicsEnabled = false;
      stopEntityPruner(bot);
      try {
        if (bot._client?.socket && bot._client.socket.listenerCount?.('error') === 0) {
          bot._client.socket.on('error', () => {});
        }
      } catch (_) {}
      // End/quit BEFORE stripping internal Mineflayer/protocol 'end' listeners so
      // physics.js doPhysicsTimer and keepalive.js timers are cleared cleanly.
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
      try {
        if (bot._client && !bot._client.ended) {
          bot._client.ended = true;
          bot._client.emit?.('end', 'cleanup');
        }
      } catch (_) {}
      try { bot.emit?.('end', 'cleanup'); } catch (_) {}
      try { bot.removeAllListeners?.(); bot.on?.('error', () => {}); } catch (_) {}
      try { bot._client?.removeAllListeners?.(); bot._client?.on?.('error', () => {}); } catch (_) {}
      try { bot.inventory?.removeAllListeners?.(); } catch (_) {}
      try { bot.currentWindow?.removeAllListeners?.(); } catch (_) {}
      try { bot._client?.socket?.destroy?.(); } catch (_) {}
      bot.entities = {};
      bot.players = {};
      bot.uuidToUsername = {};
      bot.registry = null;
      bot.world = null;
      bot.blockAt = () => null;
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
    const wasInAfk = this.isInAfkState === true && !this.manualStop && !isVerification;
    if (wasInAfk) {
      this.isInAfkState = false;
      this.wasAfkBeforeDisconnect = true;
      this.emit('event', {
        type: 'afk_kicked',
        reason: this.lastKickReason || this.lastError || 'Mất kết nối máy chủ khi đang AFK',
        message: `Bot đang treo AFK thì bị văng / mất kết nối khỏi máy chủ: ${this.lastKickReason || this.lastError || 'Mất kết nối'}`
      });
    }
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
        const currentHost = this._getCurrentHost();
        this._recordHostFailure(currentHost);
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
    this.isInAfkState = false;
    this.wasAfkBeforeDisconnect = false;
    const bot = this.bot;
    this.bot = null;
    this.cleanupSessionResources(bot);
  }

  scheduleReconnect(delayOverride) {
    if (this.manualStop || !this.config.autoReconnect || this.autoReconnect === false || this.reconnectTimer) return;
    if (isMaintenanceWindow()) {
      this.maintenanceWindow = true;
      this.setState('maintenance', 'fixed_maintenance_window');
      return;
    }
    const maxAttempts = Math.max(1, Number(this.maxReconnectAttempts || this.config.reconnectMaxAttempts) || 8);
    if (this.state !== 'maintenance') {
      if (this.reconnectAttempts >= maxAttempts) {
        const exhaustedAttempts = this.reconnectAttempts;
        const wasAfk = this.wasAfkBeforeDisconnect;
        this.logger.warn('minecraft_reconnect_limit_reached', { attempts: exhaustedAttempts, maxAttempts });
        this.manualStop = true;
        this.isInAfkState = false;
        this.wasAfkBeforeDisconnect = false;
        this.setState('error', 'max_reconnects_reached');
        this.emit('event', {
          type: 'reconnect_exhausted',
          attempts: exhaustedAttempts,
          wasAfk,
          reason: this.lastKickReason || this.lastError || 'Kết nối thất bại liên tiếp',
          message: `Bot đã thử kết nối lại ${exhaustedAttempts} lần liên tiếp không thành công (thời gian chờ tăng dần) nên đã tự động dừng.`
        });
        return;
      }
      this.reconnectAttempts += 1;
      this.reconnectCount += 1;
      this.lastReconnectAttemptCount = this.reconnectAttempts;
    }
    const baseMs = Number(this.config.reconnectBaseMs) || 5000;
    const maxMs = Math.max(baseMs, Number(this.config.reconnectMaxMs) || 180000);
    const exponential = Math.min(maxMs, baseMs * (2 ** Math.min(this.reconnectAttempts - 1, 8)));
    // Anti-cheat random spread: bounded ±5s jitter (scaled proportionally for sub-10s base configs) + 0..35% spread
    const proportionalSpread = Math.floor(Math.random() * (exponential * 0.35));
    const maxOffsetMs = Math.min(5000, Math.floor(exponential * 0.5));
    const offsetJitter = Math.floor((Math.random() * 2 - 1) * maxOffsetMs);
    const minFloorMs = Math.min(2000, Math.max(50, baseMs));
    const computedDelay = Math.max(minFloorMs, Math.min(maxMs + maxOffsetMs, exponential + proportionalSpread + offsetJitter));
    const delay = delayOverride !== undefined ? delayOverride : computedDelay;
    this.setState(this.state === 'maintenance' ? 'maintenance' : 'error', 'reconnect_scheduled');
    this.logger.info('minecraft_reconnect_scheduled', { delayMs: delay, attempt: this.reconnectAttempts, maxAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  _haltSession(reason = 'manager_stop', { emitEvent = false } = {}) {
    this._clearAbortListener();
    this.manualStop = true;
    this.isInAfkState = false;
    this.wasAfkBeforeDisconnect = false;
    this.generation += 1;
    this.clearTimers();
    if (this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if ((reason === 'process_shutdown' || reason === 'fleet_stop') && this.botScheduleTimer) {
      clearInterval(this.botScheduleTimer);
      this.botScheduleTimer = null;
    }
    const bot = this.bot;
    this.bot = null;
    this.cleanupSessionResources(bot);
    this.setState('stopped', reason);
    if (emitEvent) this.emit('event', { type: 'stopped', reason });
    return this.getStatus();
  }

  cancelPendingOperations(reason = 'command_timeout') {
    if (this.inventoryUpdateTimer) {
      clearTimeout(this.inventoryUpdateTimer);
      this.inventoryUpdateTimer = null;
    }
    this.isEquippingTotem = false;
    this.logger?.debug?.('worker_pending_operation_cancelled', { reason });
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
    if (!this.maintenanceTimer) this.scheduleMaintenanceBoundary();
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
    if (this.botScheduleTimer) {
      clearInterval(this.botScheduleTimer);
      this.botScheduleTimer = null;
    }
    this.botSchedules = [];
    this.autoChatSchedules = [];
    this.spawnCommands = '';
    this._botSchedulesSig = '';
    this._autoChatSchedulesSig = '';
    this.botScheduleCycleState = null;
    this.botScheduleDailyJitter.clear();
    this.botScheduleLastFixedKey.clear();
    this.autoChatLastFixedKey.clear();
    this.autoChatLastIntervalAt.clear();
    this.autoChatNextIntervalAt.clear();
    const bot = this.bot;
    this.bot = null;
    this.cleanupSessionResources(bot);
    this.username = '';
    this.password = '';
    this.proxy = null;
    this.connectedAt = null;
    this.auth.setPassword('');
    this.reconnectAttempts = 0;
    this.reconnectCount = 0;
    this.isInAfkState = false;
    this.wasAfkBeforeDisconnect = false;
    this.lastReconnectAttemptCount = 0;
    this.lastError = null;
    this.lastKickReason = null;
    this.state = ['ip_limited', 'banned'].includes(this.restriction) ? this.restriction : 'stopped';
    this.lastStateAt = new Date().toISOString();
    this.emit('state', this.getStatus());
    return { ok: true, worker: this.getStatus() };
  }

  hasCredentials() {
    return Boolean(this.username);
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
    if (!username || username.length > 64) {
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
    if (Object.hasOwn(settings, 'proxyUrl')) {
      try {
        this.proxy = parseSocksProxy(settings.proxyUrl, 'manager proxy');
      } catch (err) {
        this.proxy = null;
        this.logger?.warn?.('worker_invalid_manager_proxy_ignored', { error: err?.message || String(err) });
      }
    }
    if (Object.hasOwn(settings, 'ecoMode') && settings.ecoMode !== undefined) {
      const prevEco = this.ecoMode;
      this.ecoMode = Boolean(settings.ecoMode);
      if (this.bot && prevEco !== this.ecoMode && this.state === 'online') {
        setPhysicsEnabled(this.bot, !this.ecoMode, this.logger, 'settings_eco_mode');
      }
    }
    if (Object.hasOwn(settings, 'autoTotem') && settings.autoTotem !== undefined) {
      this.autoTotem = Boolean(settings.autoTotem);
      if (this.autoTotem && this.bot) void this.fastEquipTotem(this.bot);
    }
    if (Object.hasOwn(settings, 'antiHungry') && settings.antiHungry !== undefined) {
      this.antiHungry = Boolean(settings.antiHungry);
      if (this.antiHungry && this.bot && typeof this.bot.food === 'number' && this.bot.food < 16) {
        void this.tryEatFood(this.bot);
      }
    }
    if (Object.hasOwn(settings, 'autoReconnect') && settings.autoReconnect !== undefined) {
      this.autoReconnect = Boolean(settings.autoReconnect);
      if (!this.autoReconnect && this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }
    if (Object.hasOwn(settings, 'antiAfkKick') && settings.antiAfkKick !== undefined) {
      const nextAfk = Boolean(settings.antiAfkKick);
      if (this.antiAfkKick !== nextAfk) {
        this.antiAfkKick = nextAfk;
        if (this.bot) {
          if (this.antiAfkKick) this.afk.start(this.bot);
          else this.afk.stop();
        }
      }
    }
    if (Object.hasOwn(settings, 'spawnCommands') && settings.spawnCommands !== undefined) {
      this.spawnCommands = String(settings.spawnCommands || '');
    }
    if (Object.hasOwn(settings, 'autoChatSchedules') && Array.isArray(settings.autoChatSchedules)) {
      const nextSig = JSON.stringify(settings.autoChatSchedules);
      this.autoChatSchedules = settings.autoChatSchedules;
      if (nextSig !== this._autoChatSchedulesSig) {
        this._autoChatSchedulesSig = nextSig;
        this.autoChatLastIntervalAt.clear();
        this.autoChatNextIntervalAt.clear();
      }
    }
    if (Object.hasOwn(settings, 'botSchedules') && Array.isArray(settings.botSchedules)) {
      const nextSig = JSON.stringify(settings.botSchedules);
      this.botSchedules = settings.botSchedules;
      if (nextSig !== this._botSchedulesSig) {
        this._botSchedulesSig = nextSig;
        this.botScheduleDailyJitter.clear();
      }
      this.syncBotScheduleLoop();
    }
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
    this._recordChatMessage(`→ ${message}`, 'outgoing');
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
          if (FOOD_ITEM_NAMES.has(it.name)) foodCount += Number(it.count || 1);
          if (items.length < 36) items.push({ name: it.name, count: it.count, slot: s });
        }
      }
    }
    const off = rawSlots[45];
    if (off && off.name) {
      if (off.name === 'totem_of_undying' || String(off.name).includes('totem')) {
        totemCount += Number(off.count || 1);
      } else if (off.name === 'golden_apple' || off.name === 'enchanted_golden_apple') {
        goldenAppleCount += Number(off.count || 1);
      }
      if (FOOD_ITEM_NAMES.has(off.name)) {
        foodCount += Number(off.count || 1);
      }
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

  async resolvePublicIp() {
    if (this.hostPublicIp) return this.hostPublicIp;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      timer.unref?.();
      const res = await fetch('https://api.ipify.org', { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const ip = (await res.text()).trim();
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          this.hostPublicIp = ip;
        }
      }
    } catch (_) {}
    return this.hostPublicIp;
  }

  getWindowSnapshot(bot = this.bot) {
    const win = bot?.currentWindow;
    if (!win) return null;
    const rawSlots = win.slots || [];
    const len = Array.isArray(rawSlots) ? rawSlots.length : 0;

    // Xác định chính xác số ô của container (loại trừ 36 ô inventory & hotbar của người chơi)
    let containerSlots = 54;
    if (typeof win.inventoryStart === 'number' && win.inventoryStart > 0) {
      containerSlots = win.inventoryStart;
    } else if (win.type && /generic_9x([1-6])/.test(win.type)) {
      const match = win.type.match(/generic_9x([1-6])/);
      containerSlots = Number(match[1]) * 9;
    } else if (len > 36) {
      containerSlots = len - 36;
    } else if (len > 0) {
      containerSlots = len;
    }
    containerSlots = Math.max(9, Math.min(54, containerSlots));

    // Mảng cố định đúng vị trí ô, ô trống trả về null
    const slots = new Array(containerSlots);
    for (let i = 0; i < containerSlots; i++) {
      const it = rawSlots[i];
      if (it && it.name) {
        slots[i] = {
          slot: i,
          name: String(it.name),
          count: Number(it.count) || 1,
          displayName: it.displayName || it.name
        };
      } else {
        slots[i] = null;
      }
    }

    let title = win.title;
    if (typeof title === 'object' && title !== null) {
      title = title.text || title.value || JSON.stringify(title);
    }
    return {
      id: win.id,
      type: String(win.type || 'minecraft:container'),
      title: String(title || 'Container'),
      slots,
      totalSlots: containerSlots,
      revision: this.windowRevision || 0
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
      const count = Math.max(1, Math.min(640, Math.floor(Number(payload.count) || 1)));
      await bot.toss(payload.itemType, payload.metadata || null, count);
      this.inventoryRevision += 1;
      return { ok: true, tossed: payload.itemType, inventory: this.getInventorySnapshot(bot) };
    }
    return { ok: true, note: 'toss_executed_or_empty_slot', inventory: this.getInventorySnapshot(bot) };
  }

  async handleInventory(payload = {}) {
    const bot = this.requireOnlineBot();
    const action = String(payload.action || 'list').toLowerCase();
    const VALID_EQUIP_DESTINATIONS = new Set(['hand', 'head', 'torso', 'legs', 'feet', 'off-hand']);

    if (action !== 'select' && action !== 'list' && payload.revision !== undefined && payload.revision !== null && Number.isInteger(Number(payload.revision))) {
      const incomingRev = Number(payload.revision);
      if (incomingRev !== this.inventoryRevision) {
        const rawSrc = payload.sourceSlot ?? payload.slot;
        const srcSlotNum = (rawSrc !== undefined && rawSrc !== null && String(rawSrc).trim() !== '') ? Number(rawSrc) : null;
        const currentItemAtSrc = (srcSlotNum !== null && bot.inventory?.slots) ? bot.inventory.slots[srcSlotNum] : null;

        // Chỉ trả về 409 nếu ô nguồn chỉ định bị mất item hoặc không còn tồn tại
        if (srcSlotNum !== null && !currentItemAtSrc) {
          return {
            ok: false,
            error: 'inventory_revision_mismatch',
            status: 409,
            inventory: this.getInventorySnapshot(bot)
          };
        }
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
      if (bot.currentWindow) {
        return { ok: false, error: 'window_open', status: 409, inventory: this.getInventorySnapshot(bot) };
      }
      const rawSrc = payload.sourceSlot ?? payload.slot;
      const rawDst = payload.destSlot ?? payload.targetSlot;
      const src = rawSrc !== undefined && rawSrc !== null && String(rawSrc).trim() !== '' ? Number(rawSrc) : NaN;
      const dst = rawDst !== undefined && rawDst !== null && String(rawDst).trim() !== '' ? Number(rawDst) : NaN;
      if (!Number.isInteger(src) || !Number.isInteger(dst) || src < 0 || dst < 0 || src > 45 || dst > 45) {
        throw new Error('Valid sourceSlot and destSlot numbers (0-45) required.');
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
      const dest = String(payload.destination || 'hand').trim().toLowerCase();
      if (!VALID_EQUIP_DESTINATIONS.has(dest)) {
        throw new Error(`Invalid equip destination: ${dest}`);
      }
      const item = (Number.isInteger(slot) && slot >= 0 && slot <= 45 ? bot.inventory?.slots?.[slot] : null) ||
        bot.inventory?.items?.().find(i => i.name === payload.item);
      if (item && typeof bot.equip === 'function') {
        await bot.equip(item, dest);
        this.inventoryRevision += 1;
        return { ok: true, equipped: item.name, destination: dest, inventory: this.getInventorySnapshot(bot) };
      }
      return { ok: true, destination: dest, note: 'item_or_slot_empty', inventory: this.getInventorySnapshot(bot) };
    }

    if (action === 'unequip') {
      const dest = String(payload.destination || 'hand').trim().toLowerCase();
      if (!VALID_EQUIP_DESTINATIONS.has(dest)) {
        throw new Error(`Invalid unequip destination: ${dest}`);
      }
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
    const maxSlots = Array.isArray(window.slots) ? window.slots.length : 0;
    const isValidSlot = Number.isInteger(slot) && (slot === -999 || (slot >= 0 && (maxSlots === 0 || slot < maxSlots)));
    if (!isValidSlot) throw new Error('Valid slot number required.');
    if (mouseButton !== 0 && mouseButton !== 1) throw new Error('Invalid mouseButton (expected 0 or 1).');
    if (!Number.isInteger(mode) || mode < 0 || mode > 6) throw new Error('Invalid click mode (expected 0-6).');
    if (typeof bot.clickWindow === 'function') {
      await bot.clickWindow(slot, mouseButton, mode);
      this.inventoryRevision += 1;
      this.windowRevision = (this.windowRevision || 0) + 1;
      this.emit('event', {
        type: 'window_click',
        message: `Tương tác menu GUI: Click ô #${slot} (nút: ${mouseButton}, mode: ${mode})`
      });
      return { ok: true, clickedSlot: slot, inventory: this.getInventorySnapshot(bot), currentWindow: this.getWindowSnapshot(bot) };
    }
    return { ok: true, clickedSlot: slot, note: 'click_registered', inventory: this.getInventorySnapshot(bot), currentWindow: this.getWindowSnapshot(bot) };
  }

  async closeWindow() {
    const bot = this.requireOnlineBot();
    const window = bot.currentWindow;
    if (window && typeof bot.closeWindow === 'function') {
      bot.closeWindow(window);
      this.windowRevision = (this.windowRevision || 0) + 1;
      this.emit('event', {
        type: 'window_close',
        message: 'Đã đóng giao diện menu GUI.'
      });
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
            const playerObj = this.bot.players[p];
            if (playerObj?.uuid && this.bot.uuidToUsername) {
              delete this.bot.uuidToUsername[playerObj.uuid];
            }
            delete this.bot.players[p];
          }
        }
      }
      if (this.bot.uuidToUsername) {
        const ownUuid = this.bot.player?.uuid;
        for (const uuid in this.bot.uuidToUsername) {
          if (ownUuid && uuid === ownUuid) continue;
          const uname = this.bot.uuidToUsername[uuid];
          if (uname !== this.bot.username && (!this.bot.players || !this.bot.players[uname])) {
            delete this.bot.uuidToUsername[uuid];
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
    }, Math.max(50, boundary.getTime() - now.getTime() + 250));
    this.maintenanceTimer.unref?.();
  }

  enterMaintenanceWindow() {
    this.generation += 1;
    this.isInAfkState = false;
    this.wasAfkBeforeDisconnect = false;
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

  _recordChatMessage(text, source = 'chat') {
    if (!text || typeof text !== 'string') return;
    const clean = redactAuditValue(cleanText(text).replace(/[\r\n\t]+/g, ' ')).slice(0, 300).trim();
    if (!clean) return;
    if (isRestrictedMinecraftCommand(clean) || /^\/(?:login|dn|register|reg|dk)\b/i.test(clean)) return;

    const sig = `${source}:${clean.toLowerCase()}`;
    if (this.recentChatSignatures.has(sig)) return;
    this.recentChatSignatures.add(sig);
    if (this.recentChatSignatures.size > 200) {
      const first = this.recentChatSignatures.values().next().value;
      this.recentChatSignatures.delete(first);
    }
    setTimeout(() => {
      this.recentChatSignatures.delete(sig);
    }, 2500).unref?.();

    this.emit('event', { type: 'chat', message: clean, source });
  }

  recordChat(bot, username, message) {
    if (this.bot !== bot || username === bot.username) return;
    const clean = redactAuditValue(cleanText(message).replace(/[\r\n\t]+/g, ' ')).slice(0, 240);
    if (!clean) return;
    this._recordChatMessage(`[${String(username || 'player').slice(0, 40)}] ${clean}`, 'chat');
  }

  clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.locationTimer) clearInterval(this.locationTimer);
    if (this.initialLocationTimer) clearTimeout(this.initialLocationTimer);
    if (this.lobbyRoutineTimer) clearTimeout(this.lobbyRoutineTimer);
    if (this.inventoryUpdateTimer) clearTimeout(this.inventoryUpdateTimer);
    if (this.autoChatTimer) clearInterval(this.autoChatTimer);
    if (this.chunkPruneTimer) clearInterval(this.chunkPruneTimer);
    for (const t of this.spawnCommandTimers) clearTimeout(t);
    this.spawnCommandTimers.clear();
    for (const t of this.autoChatDelayTimers) clearTimeout(t);
    this.autoChatDelayTimers.clear();
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.locationTimer = null;
    this.initialLocationTimer = null;
    this.lobbyRoutineTimer = null;
    this.inventoryUpdateTimer = null;
    this.autoChatTimer = null;
    this.chunkPruneTimer = null;
    this.isEatingFood = false;
  }

  getStatus() {
    const invSnapshot = this.getInventorySnapshot(this.bot);
    const winSnapshot = this.getWindowSnapshot(this.bot);
    const monitorSnap = this.monitor.snapshot({ skipInventory: true });
    return {
      workerId: this.config.workerId, transport: this.config.transport, state: this.state,
      serverHost: this._getCurrentHost(),
      server: this._getCurrentHost(),
      locationKind: this.lastLocationKind,
      locationState: this.lastLocationKind,
      afkMode: this.afkMode, proxyEnabled: Boolean(this.proxy),
      hostIp: this.hostPublicIp, ip: this.hostPublicIp,
      username: this.username || 'N/A', credentialsConfigured: this.hasCredentials(),
      connected: Boolean(this.bot && this.bot.player), reconnectAttempts: this.reconnectAttempts,
      reconnectCount: this.reconnectCount,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      uptimeSeconds: this.connectedAt ? Math.max(0, Math.floor((Date.now() - this.connectedAt) / 1000)) : 0,
      maintenanceWindow: this.maintenanceWindow,
      maintenanceTimeZone: TIME_ZONE,
      maintenanceStart: '04:30', maintenanceEnd: '05:30',
      ...this.resourceMetrics, bandwidthRxBps: this.bandwidthRxBps, bandwidthTxBps: this.bandwidthTxBps,
      restriction: this.restriction,
      ...monitorSnap,
      totemCount: invSnapshot.totemCount,
      goldenAppleCount: invSnapshot.goldenAppleCount,
      foodCount: invSnapshot.foodCount,
      inventory: invSnapshot,
      currentWindow: winSnapshot,
      lastError: this.lastError, lastKickReason: this.lastKickReason, lastStateAt: this.lastStateAt
    };
  }
}

module.exports = {
  MinecraftSession,
  classifyServerText,
  applyCommandJitterMs,
  applyScheduleJitterMs,
  parseHhmmToMinutes,
  formatMinutesToHhmm
};

