'use strict';

const DROP_EVENTS = new Set([
  'spawn_entity', 'spawn_entity_living', 'named_entity_spawn',
  'spawn_entity_experience_orb', 'experience_orb',
  'spawn_entity_weather', 'spawn_entity_painting',
  'world_particles', 'particle', 'sound_effect', 'named_sound_effect', 'sound_entity',
  'entity_sound_effect', 'stop_sound',
  'block_break_animation', 'damage_event', 'hurt_animation',
  'open_horse_window',
  'animation', 'step', 'resource_pack_send', 'add_resource_pack', 'remove_resource_pack',
  'boss_bar', 'scoreboard_objective', 'scoreboard_score', 'scoreboard_display_objective', 'teams',
  'playerlist_header', 'tile_entity_data', 'block_action', 'map', 'trade_list',
  'open_book', 'open_sign_entity', 'craft_progress_bar', 'advancements',
  'select_advancement_tab', 'declare_recipes', 'unlock_recipes', 'statistics', 'tags',
  'chat_suggestions', 'clear_titles', 'set_title_time',
  'nbt_query_response', 'end_combat_event', 'enter_combat_event', 'experience'
]);

const ENTITY_UPDATE_EVENTS = new Set([
  'entity_velocity', 'rel_entity_move', 'entity_move_look', 'entity_look',
  'entity_teleport', 'entity_head_rotation', 'entity_status', 'entity_equipment',
  'entity_effect', 'remove_entity_effect',
  'bed', 'collect', 'set_passengers', 'attach_entity', 'entity_metadata',
  'entity_destroy', 'destroy_entity', 'update_attributes', 'entity_update_attributes'
]);

const AFK_WORLD_DROP_EVENTS = new Set([
  'map_chunk', 'unload_chunk', 'multi_block_change', 'block_change', 'explosion', 'world_event', 'world_border',
  'chunk_biomes', 'initialize_world_border', 'world_border_center', 'world_border_lerp_size',
  'world_border_size', 'world_border_warning_delay', 'world_border_warning_reach'
]);

const RESOURCE_PACK_ACK_EVENTS = new Set(['resource_pack_send', 'add_resource_pack', 'remove_resource_pack']);
const ENTITY_DESTROY_EVENTS = new Set(['entity_destroy', 'destroy_entity']);
const HUD_RESTRICTION_HINT_REGEX = /mainten|\bb[aả]o\b|[aả]o\s*tr[iì]|b[aả]o(?:\s+|"[^]{0,80}")tr|ban|c[aấ]m|\bgi[oớ]i\b|gi[oớ]i(?:\s+|"[^]{0,80}")h[aạ]n|\bip\b|\/(?:login|dn|register|reg|dk)\b|đăng\s*nh[aậ]p|dang\s*nhap|m[aậ]t\s*kh[aẩ]u|mat\s*khau|x[aá]c\s*minh|xac\s*minh|[\u0300-\u036f]/i;
const JSON_UNICODE_ESCAPE_REGEX = /\\u([0-9a-fA-F]{4})/g;

const LUT_PASS = 0;
const LUT_DROP_ALWAYS = 1;
const LUT_DROP_WHEN_WORLD_READY = 2;
const LUT_DROP_WHEN_AFK_LOCKED = 3;
const LUT_MAP_CHUNK = 4;
const LUT_ENTITY_VARINT = 5;
const LUT_ENTITY_I32 = 6;
const LUT_SYSTEM_CHAT_BOOL_TAIL = 7;
const LUT_ACTION_BAR_STRING = 8;
const LUT_PLAYER_INFO = 9;
const LUT_BUNDLE_DELIMITER = 10;
const LUT_DROP_WHEN_UNSIGNED_CHAT = 11;
const LUT_DROP_UNLESS_MOUNTED = 12;

const PLAY_PACKET_LUT_CACHE = new Map();
const PLAY_PACKET_META_CACHE = new Map();

function buildPlayPacketLut(version) {
  const verKey = String(version || '1.20.1');
  const cached = PLAY_PACKET_LUT_CACHE.get(verKey);
  if (cached !== undefined) return cached;

  try {
    const mcData = require('minecraft-data')(verKey);
    const playTypes = mcData?.protocol?.play?.toClient?.types;
    const packetDef = playTypes?.packet;
    if (!Array.isArray(packetDef) || !Array.isArray(packetDef[1])) {
      PLAY_PACKET_LUT_CACHE.set(verKey, null);
      PLAY_PACKET_META_CACHE.set(verKey, null);
      return null;
    }
    const nameEntry = packetDef[1].find((f) => f && f.name === 'name');
    const paramsEntry = packetDef[1].find((f) => f && f.name === 'params');
    const mappings = nameEntry?.type?.[1]?.mappings;
    const switchFields = paramsEntry?.type?.[1]?.fields;
    if (!mappings || !switchFields) {
      PLAY_PACKET_LUT_CACHE.set(verKey, null);
      PLAY_PACKET_META_CACHE.set(verKey, null);
      return null;
    }

    const lut = new Uint8Array(256);
    let playerInfoIgnoreMask = 0;
    for (const [hexId, name] of Object.entries(mappings)) {
      const id = Number.parseInt(hexId, 16);
      if (!Number.isInteger(id) || id < 0 || id >= 256) continue;
      if (name === 'login' || name === 'respawn' || name === 'keep_alive') {
        lut[id] = LUT_PASS;
        continue;
      }
      if (RESOURCE_PACK_ACK_EVENTS.has(name)) {
        lut[id] = LUT_PASS;
        continue;
      }
      if (name === 'bundle_delimiter') {
        lut[id] = LUT_BUNDLE_DELIMITER;
        continue;
      }
      if (name === 'declare_commands') {
        lut[id] = LUT_DROP_WHEN_UNSIGNED_CHAT;
        continue;
      }
      if (ENTITY_DESTROY_EVENTS.has(name)) {
        lut[id] = LUT_DROP_UNLESS_MOUNTED;
        continue;
      }
      if (
        DROP_EVENTS.has(name) ||
        name === 'player_remove' ||
        name === 'collect'
      ) {
        lut[id] = LUT_DROP_ALWAYS;
        continue;
      }
      if (name === 'update_light' || name === 'light_update') {
        lut[id] = LUT_DROP_WHEN_WORLD_READY;
        continue;
      }

      const typeName = switchFields[name];
      const containerDef = typeName ? playTypes[typeName] : null;
      const fields = Array.isArray(containerDef) && containerDef[0] === 'container' && Array.isArray(containerDef[1])
        ? containerDef[1]
        : null;
      const firstField = fields && fields[0] ? fields[0] : null;
      const secondField = fields && fields[1] ? fields[1] : null;

      if (name === 'map_chunk') {
        if (firstField?.name === 'x' && firstField?.type === 'i32' && secondField?.name === 'z' && secondField?.type === 'i32') {
          lut[id] = LUT_MAP_CHUNK;
        } else {
          lut[id] = LUT_DROP_WHEN_AFK_LOCKED;
        }
        continue;
      }
      if (AFK_WORLD_DROP_EVENTS.has(name)) {
        lut[id] = LUT_DROP_WHEN_AFK_LOCKED;
        continue;
      }
      if (ENTITY_UPDATE_EVENTS.has(name) && name !== 'set_passengers') {
        if (firstField?.name === 'entityId' && firstField?.type === 'varint') {
          lut[id] = LUT_ENTITY_VARINT;
        } else if (firstField?.name === 'entityId' && firstField?.type === 'i32') {
          lut[id] = LUT_ENTITY_I32;
        }
        continue;
      }
      if (name === 'system_chat' && fields?.length === 2 && firstField?.type === 'string' && secondField?.name === 'isActionBar' && secondField?.type === 'bool') {
        lut[id] = LUT_SYSTEM_CHAT_BOOL_TAIL;
        continue;
      }
      if (name === 'action_bar' && fields?.length === 1 && firstField?.type === 'string') {
        lut[id] = LUT_ACTION_BAR_STRING;
        continue;
      }
      if (
        name === 'player_info' &&
        firstField?.name === 'action' &&
        Array.isArray(firstField.type) &&
        firstField.type[0] === 'bitflags' &&
        firstField.type[1]?.type === 'u8' &&
        Array.isArray(firstField.type[1]?.flags)
      ) {
        lut[id] = LUT_PLAYER_INFO;
        const flags = firstField.type[1].flags;
        for (let bit = 0; bit < flags.length && bit < 8; bit++) {
          if (flags[bit] === 'update_listed' || flags[bit] === 'update_display_name') {
            playerInfoIgnoreMask |= (1 << bit);
          }
        }
      }
    }

    PLAY_PACKET_LUT_CACHE.set(verKey, lut);
    PLAY_PACKET_META_CACHE.set(verKey, { playerInfoIgnoreMask });
    return lut;
  } catch (_) {
    PLAY_PACKET_LUT_CACHE.set(verKey, null);
    PLAY_PACKET_META_CACHE.set(verKey, null);
    return null;
  }
}

function readVarIntAt(buf, offset) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const idx = offset + i;
    if (idx >= buf.length) return null;
    const byte = buf[idx];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  return null;
}

function parseUuidToBytes(uuidStr) {
  if (typeof uuidStr !== 'string') return null;
  const hex = uuidStr.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

function isSafeOnlineHudStringChunk(chunk, pOffset, hasTrailingBool) {
  const maxEnd = hasTrailingBool ? chunk.length - 1 : chunk.length;
  if (pOffset >= maxEnd || maxEnd - pOffset > 2048) return false;
  let strLen = 0;
  let shift = 0;
  let strOffset = pOffset;
  let validLen = false;
  for (let i = 0; i < 3 && strOffset < maxEnd; i++) {
    const b = chunk[strOffset++];
    strLen |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      validLen = true;
      break;
    }
    shift += 7;
  }
  if (!validLen || strLen < 0 || strOffset + strLen > maxEnd) return false;
  let rawText = chunk.toString('utf8', strOffset, strOffset + strLen);
  if (rawText.indexOf('\\u') !== -1) {
    rawText = rawText.replace(JSON_UNICODE_ESCAPE_REGEX, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return !HUD_RESTRICTION_HINT_REGEX.test(rawText);
}

function attachBinaryDeserializerFilter(client, bot, options = {}) {
  if (!client) return null;
  const isOnlineAuthed = typeof options.isOnlineAuthed === 'function'
    ? options.isOnlineAuthed
    : () => Boolean(bot?._kingmcOnlineAuthed);
  const isEcoMode = typeof options.isEcoMode === 'function'
    ? options.isEcoMode
    : () => true;

  let activeLut = null;
  let playerInfoIgnoreMask = 0x28;
  let lastSafeHudBuf = null;
  let cachedUuidStr = '';
  let cachedUuidBytes = null;
  let lastVerifiedPassBuf = null;

  const resetSessionFilterCache = () => {
    lastSafeHudBuf = null;
    cachedUuidStr = '';
    cachedUuidBytes = null;
    lastVerifiedPassBuf = null;
  };

  const shouldDropPlayBuffer = (chunk, baseOffset) => {
    const lut = activeLut;
    if (!lut || baseOffset >= chunk.length) return false;

    const b0 = chunk[baseOffset];
    let packetId = b0;
    let pOffset = baseOffset + 1;
    if ((b0 & 0x80) !== 0) {
      if (chunk.length < baseOffset + 2) return false;
      const b1 = chunk[baseOffset + 1];
      if ((b1 & 0x80) !== 0) return false;
      packetId = (b0 & 0x7f) | (b1 << 7);
      pOffset = baseOffset + 2;
    }

    if (packetId >= 256) return false;
    const action = lut[packetId];
    if (action === LUT_PASS) return false;
    if (action === LUT_DROP_ALWAYS) return true;
    if (action === LUT_BUNDLE_DELIMITER) {
      return !client._mcBundle || client._mcBundle.length === 0;
    }
    if (action === LUT_DROP_WHEN_UNSIGNED_CHAT) {
      return !client.profileKeys && !client._session;
    }
    if (action === LUT_DROP_UNLESS_MOUNTED) {
      return !bot?.vehicle;
    }
    if (action === LUT_DROP_WHEN_WORLD_READY) {
      return Boolean(bot?.world);
    }
    if (action === LUT_DROP_WHEN_AFK_LOCKED) {
      return Boolean(bot?._kingmcAfkWorldLocked && bot.physicsEnabled === false);
    }
    if (action === LUT_MAP_CHUNK) {
      if (bot?._kingmcAfkWorldLocked && bot.physicsEnabled === false) return true;
      const pos = bot?.entity?.position;
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z) && chunk.length >= pOffset + 8) {
        const pktX = chunk.readInt32BE(pOffset);
        const pktZ = chunk.readInt32BE(pOffset + 4);
        const cx = Math.floor(pos.x / 16);
        const cz = Math.floor(pos.z / 16);
        const maxRadius = isEcoMode() ? 1 : 2;
        if (Math.abs(pktX - cx) > maxRadius || Math.abs(pktZ - cz) > maxRadius) {
          return true;
        }
      }
      return false;
    }
    if (action === LUT_ENTITY_VARINT) {
      const botId = bot?.entity?.id;
      if (botId !== undefined && botId !== null) {
        const targetId = readVarIntAt(chunk, pOffset);
        if (targetId !== null && targetId !== botId) return true;
      }
      return false;
    }
    if (action === LUT_ENTITY_I32) {
      const botId = bot?.entity?.id;
      if (botId !== undefined && botId !== null && chunk.length >= pOffset + 4) {
        if (chunk.readInt32BE(pOffset) !== botId) return true;
      }
      return false;
    }
    if (action === LUT_SYSTEM_CHAT_BOOL_TAIL) {
      if (chunk.length > pOffset + 1 && chunk[chunk.length - 1] === 1 && isOnlineAuthed()) {
        const pktLen = chunk.length - baseOffset;
        if (
          lastSafeHudBuf &&
          pktLen === lastSafeHudBuf.length &&
          chunk.compare(lastSafeHudBuf, 0, lastSafeHudBuf.length, baseOffset, chunk.length) === 0
        ) {
          return true;
        }
        if (isSafeOnlineHudStringChunk(chunk, pOffset, true)) {
          lastSafeHudBuf = Buffer.from(chunk.subarray(baseOffset));
          return true;
        }
      }
      return false;
    }
    if (action === LUT_ACTION_BAR_STRING) {
      if (chunk.length > pOffset && isOnlineAuthed()) {
        const pktLen = chunk.length - baseOffset;
        if (
          lastSafeHudBuf &&
          pktLen === lastSafeHudBuf.length &&
          chunk.compare(lastSafeHudBuf, 0, lastSafeHudBuf.length, baseOffset, chunk.length) === 0
        ) {
          return true;
        }
        if (isSafeOnlineHudStringChunk(chunk, pOffset, false)) {
          lastSafeHudBuf = Buffer.from(chunk.subarray(baseOffset));
          return true;
        }
      }
      return false;
    }
    if (action === LUT_PLAYER_INFO) {
      if (chunk.length > pOffset && bot?.player && bot?.players && bot?.username && bot.players[bot.username]) {
        const actionMask = chunk[pOffset];
        if (actionMask !== 0 && playerInfoIgnoreMask !== 0 && (actionMask & ~playerInfoIgnoreMask) === 0) {
          return true;
        }
        const rawUuid = bot.player.uuid || bot?._client?.uuid;
        if (rawUuid) {
          if (rawUuid !== cachedUuidStr) {
            cachedUuidStr = rawUuid;
            cachedUuidBytes = parseUuidToBytes(rawUuid);
          }
          if (cachedUuidBytes && chunk.indexOf(cachedUuidBytes, pOffset + 1) === -1) {
            return true;
          }
        }
      }
      return false;
    }
    return false;
  };

  const installStreamHooks = () => {
    const isPlay = client.protocolState === 'play' || client.state === 'play';
    if (isPlay && !activeLut) {
      const verKey = String(client.version || bot?.version || '1.20.1');
      activeLut = buildPlayPacketLut(verKey);
      const meta = PLAY_PACKET_META_CACHE.get(verKey);
      if (meta && typeof meta.playerInfoIgnoreMask === 'number') {
        playerInfoIgnoreMask = meta.playerInfoIgnoreMask;
      }
    }

    const decompressor = client.decompressor;
    if (decompressor && !decompressor._kingmcBinaryFilterAttached && typeof decompressor._transform === 'function') {
      decompressor._kingmcBinaryFilterAttached = true;
      const origDecompress = decompressor._transform;
      decompressor._transform = function filteredDecompressTransform(chunk, enc, cb) {
        if (
          activeLut &&
          (client.protocolState === 'play' || client.state === 'play') &&
          Buffer.isBuffer(chunk) &&
          chunk.length > 1 &&
          chunk[0] === 0
        ) {
          if (shouldDropPlayBuffer(chunk, 1)) {
            return cb();
          }
          const sub = chunk.subarray(1);
          lastVerifiedPassBuf = sub;
          this.push(sub);
          return cb();
        }
        return origDecompress.call(this, chunk, enc, cb);
      };
    }

    const deserializer = client.deserializer;
    if (isPlay && activeLut && deserializer && !deserializer._kingmcBinaryFilterAttached && typeof deserializer._transform === 'function') {
      deserializer._kingmcBinaryFilterAttached = true;
      const origTransform = deserializer._transform;
      deserializer._transform = function filteredTransform(chunk, enc, cb) {
        if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
          return origTransform.call(this, chunk, enc, cb);
        }
        if (chunk === lastVerifiedPassBuf) {
          lastVerifiedPassBuf = null;
          return origTransform.call(this, chunk, enc, cb);
        }
        if (shouldDropPlayBuffer(chunk, 0)) {
          return cb();
        }
        return origTransform.call(this, chunk, enc, cb);
      };
    }
  };

  installStreamHooks();
  if (!client._kingmcCompressionHooked && typeof client.setCompressionThreshold === 'function') {
    client._kingmcCompressionHooked = true;
    const origSetCompression = client.setCompressionThreshold;
    client.setCompressionThreshold = function wrappedSetCompressionThreshold(threshold) {
      const res = origSetCompression.call(this, threshold);
      installStreamHooks();
      return res;
    };
  }
  if (!client._kingmcStateDeserializerHooked && typeof client.on === 'function') {
    client._kingmcStateDeserializerHooked = true;
    client.on('state', (newState) => {
      if (newState === 'play') installStreamHooks();
    });
  }

  return { resetSessionFilterCache };
}

const AFK_GROUND_SENTINEL = Object.freeze({ type: 0, name: 'air', boundingBox: 'empty', stateId: 0 });

const DISABLED_PLUGINS = Object.freeze({
  particle: false, sound: false, explosion: false, fishing: false, digging: false,
  craft: false, creative: false, enchantment_table: false, furnace: false, anvil: false,
  book: false, command_block: false, villager: false, place_block: false,
  place_entity: false, ray_trace: false, resource_pack: false,
  generic_place: false, rain: false,
  boss_bar: false, scoreboard: false, team: false, tablist: false,
  bed: false, block_actions: false, breath: false, experience: false, spawn_point: false
});

function sendLightweightResourcePackAck(client, packet) {
  if (!client || typeof client.write !== 'function') return;
  try {
    if (packet && packet.uuid) {
      client.write('resource_pack_receive', { uuid: packet.uuid, result: 0 });
      client.write('resource_pack_receive', { uuid: packet.uuid, result: 3 });
    } else {
      client.write('resource_pack_receive', { result: 0 });
      client.write('resource_pack_receive', { result: 3 });
    }
  } catch (_) {}
}

function attachEarlyPacketDropFilter(bot, options = {}) {
  const isEcoMode = typeof options.isEcoMode === 'function'
    ? options.isEcoMode
    : () => true;
  const hook = (client) => {
    if (!client) return;
    const binaryHandle = attachBinaryDeserializerFilter(client, bot, options);
    if (binaryHandle && typeof binaryHandle.resetSessionFilterCache === 'function') {
      client._kingmcResetBinaryCache = binaryHandle.resetSessionFilterCache;
    }
    if (client._kingmcDropHookAttached) return;
    client._kingmcDropHookAttached = true;
    const originalEmit = client.emit;
    client.emit = function emit(name, ...args) {
      if (name === 'packet' || name === 'raw' || (typeof name === 'string' && name.charCodeAt(0) === 114 && name.startsWith('raw.'))) {
        return this._events && this._events[name] ? originalEmit.apply(this, [name, ...args]) : false;
      }
      if (name === 'login' || name === 'respawn') {
        if (bot) {
          bot._kingmcAfkWorldLocked = false;
          bot._afkChunksClearedOnce = false;
        }
        this._kingmcResetBinaryCache?.();
        return originalEmit.apply(this, [name, ...args]);
      }
      if (bot?._kingmcAfkWorldLocked && bot.physicsEnabled === false && AFK_WORLD_DROP_EVENTS.has(name)) {
        return false;
      }
      if (name === 'resource_pack_send' || name === 'add_resource_pack') {
        sendLightweightResourcePackAck(this, args[0]);
        return false;
      }
      if (name === 'declare_commands') {
        if (!this.profileKeys && !this._session) return false;
        return originalEmit.apply(this, [name, ...args]);
      }
      if (DROP_EVENTS.has(name)) return false;
      if (name === 'player_remove') return false;
      if (ENTITY_UPDATE_EVENTS.has(name)) {
        const packet = args[0];
        const botId = bot?.entity?.id;
        const vehicleId = bot?.vehicle?.id;
        if (packet) {
          if (botId !== undefined && botId !== null && packet.entityId !== undefined && packet.entityId === botId) {
            return originalEmit.apply(this, [name, ...args]);
          }
          if (name === 'set_passengers') {
            const includesSelf = botId !== undefined && botId !== null && Array.isArray(packet.passengers) && packet.passengers.includes(botId);
            const isMountedVehicle = vehicleId !== undefined && vehicleId !== null && packet.entityId === vehicleId;
            if (includesSelf || isMountedVehicle) {
              return originalEmit.apply(this, [name, ...args]);
            }
          }
          if (ENTITY_DESTROY_EVENTS.has(name) && vehicleId !== undefined && vehicleId !== null) {
            if (Array.isArray(packet.entityIds) && packet.entityIds.includes(vehicleId)) {
              return originalEmit.apply(this, [name, ...args]);
            }
          }
        }
        return false;
      }
      if (name === 'player_info') {
        const packet = args[0];
        if (packet && Array.isArray(packet.data)) {
          const botName = bot?.username || bot?._client?.username;
          const botUuid = bot?.player?.uuid || bot?._client?.uuid;
          if (botName || botUuid) {
            const filtered = packet.data.filter((item) => {
              if (!item) return false;
              if (botUuid && item.uuid === botUuid) return true;
              const itemName = item.player?.name || item.name;
              if (botName && itemName && itemName === botName) return true;
              return false;
            });
            if (filtered.length === 0) return false;
            packet.data = filtered;
          }
        }
      } else if (name === 'map_chunk') {
        const packet = args[0];
        if (packet && typeof packet === 'object') {
          const pos = bot?.entity?.position;
          if (
            pos &&
            Number.isFinite(pos.x) &&
            Number.isFinite(pos.z) &&
            Number.isFinite(packet.x) &&
            Number.isFinite(packet.z)
          ) {
            const cx = Math.floor(pos.x / 16);
            const cz = Math.floor(pos.z / 16);
            const maxRadius = isEcoMode() ? 1 : 2;
            if (Math.abs(packet.x - cx) > maxRadius || Math.abs(packet.z - cz) > maxRadius) {
              return false;
            }
          }
          if (Array.isArray(packet.blockEntities) && packet.blockEntities.length > 0) {
            packet.blockEntities = [];
          }
          packet.skyLight = undefined;
          packet.blockLight = undefined;
          packet.skyLightMask = undefined;
          packet.blockLightMask = undefined;
          packet.emptySkyLightMask = undefined;
          packet.emptyBlockLightMask = undefined;
        }
      } else if (name === 'update_light' && bot?.world) {
        return false;
      }
      return originalEmit.apply(this, [name, ...args]);
    };
  };
  hook(bot?._client);
  bot?.once?.('inject_allowed', () => hook(bot._client));
  enforceZeroFarmEntities(bot);
}

function enforceZeroFarmEntities(bot) {
  if (!bot || typeof bot.on !== 'function' || bot._kingmcZeroEntitiesAttached) return;
  bot._kingmcZeroEntitiesAttached = true;

  bot.on('entitySpawn', (entity) => {
    if (entity && entity !== bot.entity && entity !== bot.vehicle && bot.entities) {
      delete bot.entities[entity.id];
    }
  });

  const timer = setInterval(() => {
    try {
      if (!bot.entities || typeof bot.entities !== 'object') return;
      const botId = bot.entity?.id;
      const vehicleId = bot.vehicle?.id;
      for (const id in bot.entities) {
        const numId = Number(id);
        if (botId !== undefined && botId !== null && numId === botId) continue;
        if (vehicleId !== undefined && vehicleId !== null && numId === vehicleId) continue;
        const ent = bot.entities[id];
        if (ent && ent !== bot.entity && ent !== bot.vehicle) {
          if (ent.metadata) ent.metadata = [];
          delete bot.entities[id];
        }
      }
    } catch (_) {}
  }, 60000);
  timer.unref?.();
  bot._kingmcEntityPruneTimer = timer;
  bot.once?.('end', () => stopEntityPruner(bot));
}

function stopEntityPruner(bot) {
  const timer = bot?._kingmcEntityPruneTimer;
  if (!timer) return false;
  clearInterval(timer);
  bot._kingmcEntityPruneTimer = null;
  return true;
}

function applyEcoPhysics(bot) {
  if (bot?.physics) bot.physics.maxCatchupTicks = 0;
  if (bot) bot.physicsEnabled = true;
}

function setAfkWorldChunkLock(bot, locked) {
  if (!bot) return false;
  if (!bot._kingmcBlockAtWrapped) {
    const origBlockAt = typeof bot.blockAt === 'function' ? bot.blockAt.bind(bot) : () => null;
    bot._kingmcOrigBlockAt = origBlockAt;
    bot._kingmcBlockAtWrapped = true;
    bot._lastEcoPosTickAt = 0;
    bot._ecoSmoothLookUntil = 0;
    bot._lastEcoTickYaw = NaN;
    bot._lastEcoTickPitch = NaN;
    bot.blockAt = (point, extraInfos) => {
      if (bot._kingmcAfkWorldLocked && bot.physicsEnabled === false) {
        // Throttle Mineflayer's 20Hz (50ms) tickPhysics -> updatePosition loop down to 1Hz (1000ms)
        // when standing still in AFK mode, while waking at full 20Hz for 500ms on any yaw/pitch rotation
        const ent = bot.entity;
        if (ent && point === ent.position && extraInfos === undefined) {
          const now = Date.now();
          const hadPrevAngle = Number.isFinite(bot._lastEcoTickYaw);
          const yawChanged = ent.yaw !== bot._lastEcoTickYaw || ent.pitch !== bot._lastEcoTickPitch;
          if (yawChanged && hadPrevAngle) {
            bot._ecoSmoothLookUntil = now + 500;
          }
          if (!yawChanged && now >= bot._ecoSmoothLookUntil && bot._lastEcoPosTickAt > 0 && (now - bot._lastEcoPosTickAt) < 950) {
            return null;
          }
          bot._lastEcoPosTickAt = now;
          bot._lastEcoTickYaw = ent.yaw;
          bot._lastEcoTickPitch = ent.pitch;
        }
        return AFK_GROUND_SENTINEL;
      }
      return origBlockAt(point, extraInfos);
    };
  }
  const nextLocked = Boolean(locked);
  const wasLocked = Boolean(bot._kingmcAfkWorldLocked);
  bot._kingmcAfkWorldLocked = nextLocked;
  if (!nextLocked) {
    bot._afkChunksClearedOnce = false;
    bot._lastEcoPosTickAt = 0;
    bot._ecoSmoothLookUntil = 0;
  } else if (!wasLocked || !bot._afkChunksClearedOnce) {
    try {
      pruneFarChunks(bot, -1);
      bot._afkChunksClearedOnce = true;
    } catch (_) {}
  }
  return nextLocked;
}

function setPhysicsEnabled(bot, enabled, logger, reason = '') {
  if (!bot) return;
  const prev = bot.physicsEnabled !== false;
  const nextEnabled = Boolean(enabled);
  if (nextEnabled) {
    bot._kingmcAfkWorldLocked = false;
    bot._afkChunksClearedOnce = false;
    bot._lastEcoPosTickAt = 0;
  }
  bot.physicsEnabled = nextEnabled;
  if (prev !== bot.physicsEnabled && logger) {
    logger.info('physics_toggled', { enabled: bot.physicsEnabled, reason });
  }
}

function pruneFarChunks(bot, radius = 2) {
  if (radius < 0 && bot?._kingmcAfkWorldLocked && bot?._afkChunksClearedOnce) {
    return 0;
  }
  const world = bot?.world;
  if (!world || typeof world.getColumns !== 'function') return 0;
  const position = bot?.entity?.position;
  if (radius >= 0 && !position) return 0;
  const chunkX = position ? Math.floor(position.x / 16) : 0;
  const chunkZ = position ? Math.floor(position.z / 16) : 0;
  const columns = world.getColumns();
  if (!Array.isArray(columns)) return 0;
  let unloaded = 0;
  for (const column of columns) {
    const x = Number(column?.chunkX ?? column?.x);
    const z = Number(column?.chunkZ ?? column?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (radius >= 0 && Math.abs(x - chunkX) <= radius && Math.abs(z - chunkZ) <= radius) continue;
    if (typeof world.unloadColumn === 'function') {
      world.unloadColumn(x, z);
      unloaded += 1;
    }
  }
  return unloaded;
}

function startChunkPruner(bot, { intervalMs = 45000, radius = 1 } = {}) {
  const timer = setInterval(() => {
    try { pruneFarChunks(bot, bot?._kingmcAfkWorldLocked ? -1 : radius); } catch (_) {}
  }, intervalMs);
  timer.unref?.();
  bot?.once?.('end', () => clearInterval(timer));
  return timer;
}

module.exports = {
  DISABLED_PLUGINS,
  DROP_EVENTS,
  AFK_WORLD_DROP_EVENTS,
  AFK_GROUND_SENTINEL,
  buildPlayPacketLut,
  attachBinaryDeserializerFilter,
  attachEarlyPacketDropFilter,
  optimizeBotPackets: attachEarlyPacketDropFilter,
  enforceZeroFarmEntities,
  stopEntityPruner,
  applyEcoPhysics,
  setAfkWorldChunkLock,
  setPhysicsEnabled,
  pruneFarChunks,
  startChunkPruner
};
