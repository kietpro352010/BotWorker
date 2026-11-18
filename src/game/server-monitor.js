'use strict';

class ServerMonitor {
  constructor({ sampleMs = 10000 } = {}) {
    this.sampleMs = sampleMs;
    this.bot = null;
    this.ticks = 0;
    this.tps = null;
    this.timer = null;
    this.lastTimeAge = null;
    this.lastTimeAt = 0;
    this.onPhysicsTick = () => { this.ticks += 1; };
    this.onServerTime = () => {
      if (!this.bot) return;
      const now = Date.now();
      const currentAge = this.bot.time?.age;
      if (Number.isFinite(currentAge) && Number.isFinite(this.lastTimeAge)) {
        const deltaTicks = currentAge - this.lastTimeAge;
        const deltaSec = (now - this.lastTimeAt) / 1000;
        if (deltaSec > 0.5 && deltaTicks >= 0) {
          this.tps = Math.min(20, Math.max(0, Math.round((deltaTicks / deltaSec) * 10) / 10));
          this.lastTimeAge = currentAge;
          this.lastTimeAt = now;
        }
      } else if (Number.isFinite(currentAge)) {
        this.lastTimeAge = currentAge;
        this.lastTimeAt = now;
      }
    };
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    this.ticks = 0;
    this.lastTimeAge = bot?.time?.age ?? null;
    this.lastTimeAt = Date.now();
    if (typeof bot?.on === 'function') {
      bot.on('physicsTick', this.onPhysicsTick);
      bot.on('time', this.onServerTime);
    }
    this.timer = setInterval(() => {
      if (this.ticks > 0) {
        this.tps = Math.min(20, Math.round((this.ticks * 1000 / this.sampleMs) * 10) / 10);
        this.ticks = 0;
      } else if (this.tps === null) {
        this.tps = 20;
      }
    }, this.sampleMs);
    this.timer.unref?.();
  }

  snapshot() {
    const position = this.bot?.entity?.position;
    const pingMs = Number(this.bot?.player?.ping);

    // Count Totems & Golden Apples in inventory
    let totemCount = 0;
    let goldenAppleCount = 0;
    const itemsSummary = [];

    if (this.bot?.inventory) {
      const items = (this.bot.inventory.items() || []).filter((item) => item && item.slot !== 45);
      for (const item of items) {
        if (!item) continue;
        if (item.name === 'totem_of_undying') {
          totemCount += Number(item.count || 1);
        } else if (item.name === 'golden_apple' || item.name === 'enchanted_golden_apple') {
          goldenAppleCount += Number(item.count || 1);
        }
        if (itemsSummary.length < 10) {
          itemsSummary.push({ name: item.name, count: item.count });
        }
      }
      // Check off-hand slot (slot 45 in 1.9+)
      const offHand = this.bot.inventory.slots?.[45];
      if (offHand && offHand.name === 'totem_of_undying') {
        totemCount += Number(offHand.count || 1);
      }
    }

    return {
      tps: this.tps,
      pingMs: Number.isFinite(pingMs) && pingMs >= 0 ? Math.round(pingMs) : null,
      health: Number.isFinite(this.bot?.health) ? Math.round(this.bot.health) : 20,
      food: Number.isFinite(this.bot?.food) ? Math.round(this.bot.food) : 20,
      totemCount,
      goldenAppleCount,
      inventory: itemsSummary,
      position: position && [position.x, position.y, position.z].every(Number.isFinite)
        ? { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10, z: Math.round(position.z * 10) / 10 }
        : null,
      dimension: String(this.bot?.game?.dimension || '').slice(0, 40) || null
    };
  }

  detach() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.bot && typeof this.bot.removeListener === 'function') {
      if (this.onPhysicsTick) this.bot.removeListener('physicsTick', this.onPhysicsTick);
      if (this.onServerTime) this.bot.removeListener('time', this.onServerTime);
    }
    this.bot = null;
    this.ticks = 0;
    this.tps = null;
    this.lastTimeAge = null;
    this.lastTimeAt = 0;
  }
}

module.exports = ServerMonitor;
