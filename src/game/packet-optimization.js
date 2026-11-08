'use strict';

const DROP_EVENTS = new Set([
  'spawn_entity', 'spawn_entity_living', 'named_entity_spawn',
  'spawn_entity_experience_orb', 'experience_orb',
  'spawn_entity_weather', 'spawn_entity_painting',
  'world_particles', 'particle', 'sound_effect', 'named_sound_effect', 'sound_entity',
  'update_light', 'explosion', 'block_break_animation',
  'entity_effect', 'remove_entity_effect', 'open_horse_window',
  'animation', 'step', 'resource_pack_send', 'add_resource_pack', 'remove_resource_pack'
]);

const ENTITY_UPDATE_EVENTS = new Set([
  'entity_velocity', 'rel_entity_move', 'entity_move_look', 'entity_look',
  'entity_teleport', 'entity_head_rotation', 'entity_status', 'entity_equipment',
  'bed', 'collect', 'set_passengers', 'attach_entity', 'entity_metadata',
  'entity_destroy', 'destroy_entity'
]);

const DISABLED_PLUGINS = Object.freeze({
  particle: false, sound: false, explosion: false, fishing: false, digging: false,
  craft: false, creative: false, enchantment_table: false, furnace: false, anvil: false,
  book: false, command_block: false, villager: false, place_block: false,
  place_entity: false, ray_trace: false, resource_pack: false,
  generic_place: false, rain: false
});

function attachEarlyPacketDropFilter(bot) {
  const hook = (client) => {
    if (!client || client._kingmcDropHookAttached) return;
    client._kingmcDropHookAttached = true;
    const originalEmit = client.emit;
    client.emit = function emit(name, ...args) {
      if (DROP_EVENTS.has(name)) return false;
      if (ENTITY_UPDATE_EVENTS.has(name)) {
        const packet = args[0];
        const botId = bot?.entity?.id;
        if (botId && packet && packet.entityId !== undefined && packet.entityId === botId) {
          return originalEmit.apply(this, [name, ...args]);
        }
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
  if (!bot || bot._kingmcZeroEntitiesAttached) return;
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
        if (botId && Number(id) === botId) continue;
        const ent = bot.entities[id];
        if (ent && ent !== bot.entity) {
          if (ent.metadata) ent.metadata = [];
          delete bot.entities[id];
        }
      }
    } catch (_) {}
  }, 5000);
  timer.unref?.();
}

function applyEcoPhysics(bot) {
  if (bot?.physics) bot.physics.maxCatchupTicks = 0;
  if (bot) bot.physicsEnabled = true;
}

function pruneFarChunks(bot, radius = 2) {
  const position = bot?.entity?.position;
  const world = bot?.world;
  if (!position || !world || typeof world.getColumns !== 'function') return 0;
  const chunkX = Math.floor(position.x / 16);
  const chunkZ = Math.floor(position.z / 16);
  const columns = world.getColumns();
  if (!Array.isArray(columns)) return 0;
  let unloaded = 0;
  for (const column of columns) {
    const x = Number(column?.chunkX ?? column?.x);
    const z = Number(column?.chunkZ ?? column?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (Math.abs(x - chunkX) <= radius && Math.abs(z - chunkZ) <= radius) continue;
    if (typeof world.unloadColumn === 'function') {
      world.unloadColumn(x, z);
      unloaded += 1;
    }
  }
  return unloaded;
}

function startChunkPruner(bot, { intervalMs = 30000, radius = 2 } = {}) {
  const timer = setInterval(() => {
    try { pruneFarChunks(bot, radius); } catch (_) {}
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { DISABLED_PLUGINS, DROP_EVENTS, attachEarlyPacketDropFilter, applyEcoPhysics, pruneFarChunks, startChunkPruner };
