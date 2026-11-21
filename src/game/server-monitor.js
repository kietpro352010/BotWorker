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
        } else if (deltaTicks < 0) {
          // Server switch (e.g. lobby -> survival) or world restart reset world age
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
      if (this.lastTimeAge === null) {
        if (this.ticks > 0) {
          this.tps = Math.min(20, Math.round((this.ticks * 1000 / this.sampleMs) * 10) / 10);
        } else if (this.tps === null) {
          this.tps = 20;
        }
      }
      this.ticks = 0;
    }, this.sampleMs);
    this.timer.unref?.();
  }

  snapshot({ skipInventory = false } = {}) {
    const position = this.bot?.entity?.position;
    const pingMs = Number(this.bot?.player?.ping);

    let rawDim = this.bot?.game?.dimension;
    if (typeof rawDim === 'object' && rawDim !== null) {
      rawDim = rawDim.name || rawDim.effects || rawDim.id || '';
    }
    const cleanDim = String(rawDim || '').trim().replace(/^minecraft:/i, '').slice(0, 40) || null;

    const base = {
      tps: this.tps,
      pingMs: Number.isFinite(pingMs) && pingMs >= 0 ? Math.round(pingMs) : null,
      health: Number.isFinite(this.bot?.health) ? Math.round(this.bot.health) : 20,
      food: Number.isFinite(this.bot?.food) ? Math.round(this.bot.food) : 20,
      position: position && [position.x, position.y, position.z].every(Number.isFinite)
        ? { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10, z: Math.round(position.z * 10) / 10 }
        : null,
      dimension: cleanDim
    };

    if (skipInventory) {
      return base;
    }

    // Count Totems & Golden Apples in inventory
    let totemCount = 0;
    let goldenAppleCount = 0;
    const itemsSummary = [];

    if (this.bot?.inventory) {
      const items = (this.bot.inventory.items() || []).filter((item) => item && item.slot !== 45);
      for (const item of items) {
        if (!item) continue;
        const itemName = String(item.name || '').toLowerCase();
        if (itemName.includes('totem')) {
          totemCount += Number(item.count || 1);
        } else if (itemName === 'golden_apple' || itemName === 'enchanted_golden_apple') {
          goldenAppleCount += Number(item.count || 1);
        }
        if (itemsSummary.length < 10) {
          itemsSummary.push({ name: item.name, count: item.count });
        }
      }
      // Check off-hand slot (slot 45 in 1.9+)
      const offHand = this.bot.inventory.slots?.[45];
      if (offHand) {
        const offHandName = String(offHand.name || '').toLowerCase();
        if (offHandName.includes('totem')) {
          totemCount += Number(offHand.count || 1);
        } else if (offHandName === 'golden_apple' || offHandName === 'enchanted_golden_apple') {
          goldenAppleCount += Number(offHand.count || 1);
        }
      }
    }

    return {
      ...base,
      totemCount,
      goldenAppleCount,
      inventory: itemsSummary
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
