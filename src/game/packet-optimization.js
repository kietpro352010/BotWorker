'use strict';

const DROP_EVENTS = new Set([
  'spawn_entity', 'spawn_entity_living', 'named_entity_spawn',
  'spawn_entity_experience_orb', 'experience_orb',
  'spawn_entity_weather', 'spawn_entity_painting',
  'world_particles', 'particle', 'sound_effect', 'named_sound_effect', 'sound_entity',
  'explosion', 'block_break_animation',
  'entity_effect', 'remove_entity_effect', 'open_horse_window',
  'animation', 'step', 'resource_pack_send', 'add_resource_pack', 'remove_resource_pack',
  'boss_bar', 'scoreboard_objective', 'scoreboard_score', 'scoreboard_display_objective', 'teams',
  'playerlist_header', 'tile_entity_data', 'block_action', 'map', 'trade_list',
  'open_book', 'open_sign_entity', 'craft_progress_bar', 'advancements',
  'select_advancement_tab', 'declare_recipes', 'unlock_recipes', 'statistics', 'tags'
]);

const ENTITY_UPDATE_EVENTS = new Set([
  'entity_velocity', 'rel_entity_move', 'entity_move_look', 'entity_look',
  'entity_teleport', 'entity_head_rotation', 'entity_status', 'entity_equipment',
  'bed', 'collect', 'set_passengers', 'attach_entity', 'entity_metadata',
  'entity_destroy', 'destroy_entity', 'update_attributes', 'entity_update_attributes'
]);

const AFK_WORLD_DROP_EVENTS = new Set([
  'map_chunk', 'unload_chunk', 'multi_block_change', 'block_change', 'world_event', 'world_border'
]);

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

function attachEarlyPacketDropFilter(bot) {
  const hook = (client) => {
    if (!client || client._kingmcDropHookAttached) return;
    client._kingmcDropHookAttached = true;
    const originalEmit = client.emit;
    client.emit = function emit(name, ...args) {
      if (name === 'login' || name === 'respawn') {
        if (bot) bot._kingmcAfkWorldLocked = false;
        return originalEmit.apply(this, [name, ...args]);
      }
      if (bot?._kingmcAfkWorldLocked && bot.physicsEnabled === false && AFK_WORLD_DROP_EVENTS.has(name)) {
        return false;
      }
      if (name === 'resource_pack_send' || name === 'add_resource_pack') {
        sendLightweightResourcePackAck(this, args[0]);
        return false;
      }
      if (DROP_EVENTS.has(name)) return false;
      if (name === 'player_remove') return false;
      if (ENTITY_UPDATE_EVENTS.has(name)) {
        const packet = args[0];
        const botId = bot?.entity?.id;
        if (botId !== undefined && botId !== null && packet) {
          if (packet.entityId !== undefined && packet.entityId === botId) {
            return originalEmit.apply(this, [name, ...args]);
          }
          if (name === 'set_passengers' && Array.isArray(packet.passengers) && packet.passengers.includes(botId)) {
            return originalEmit.apply(this, [name, ...args]);
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
            if (Math.abs(packet.x - cx) > 1 || Math.abs(packet.z - cz) > 1) {
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
    if (entity && entity !== bot.entity && bot.entities) {
      delete bot.entities[entity.id];
    }
  });

  const timer = setInterval(() => {
    try {
      if (!bot.entities || typeof bot.entities !== 'object') return;
      const botId = bot.entity?.id;
      for (const id in bot.entities) {
        if (botId !== undefined && botId !== null && Number(id) === botId) continue;
        const ent = bot.entities[id];
        if (ent && ent !== bot.entity) {
          if (ent.metadata) ent.metadata = [];
          delete bot.entities[id];
        }
      }
    } catch (_) {}
  }, 15000);
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
  if (!bot._kingmcBlockAtWrapped && typeof bot.blockAt === 'function') {
    const origBlockAt = bot.blockAt.bind(bot);
    bot._kingmcOrigBlockAt = origBlockAt;
    bot._kingmcBlockAtWrapped = true;
    bot.blockAt = (point, extraInfos) => {
      if (bot._kingmcAfkWorldLocked && bot.physicsEnabled === false) {
        return AFK_GROUND_SENTINEL;
      }
      return origBlockAt(point, extraInfos);
    };
  }
  const nextLocked = Boolean(locked);
  bot._kingmcAfkWorldLocked = nextLocked;
  if (nextLocked) {
    try { pruneFarChunks(bot, -1); } catch (_) {}
  }
  return nextLocked;
}

function setPhysicsEnabled(bot, enabled, logger, reason = '') {
  if (!bot) return;
  const prev = bot.physicsEnabled !== false;
  const nextEnabled = Boolean(enabled);
  if (nextEnabled) {
    bot._kingmcAfkWorldLocked = false;
  }
  bot.physicsEnabled = nextEnabled;
  if (prev !== bot.physicsEnabled && logger) {
    logger.info('physics_toggled', { enabled: bot.physicsEnabled, reason });
  }
}

function pruneFarChunks(bot, radius = 2) {
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
