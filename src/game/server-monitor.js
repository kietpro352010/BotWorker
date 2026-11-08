'use strict';

class ServerMonitor {
  constructor({ sampleMs = 10000 } = {}) {
    this.sampleMs = sampleMs;
    this.bot = null;
    this.ticks = 0;
    this.tps = null;
    this.timer = null;
    this.onPhysicsTick = () => { this.ticks += 1; };
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    this.ticks = 0;
    bot.on('physicsTick', this.onPhysicsTick);
    this.timer = setInterval(() => {
      this.tps = Math.min(20, Math.round((this.ticks * 1000 / this.sampleMs) * 10) / 10);
      this.ticks = 0;
    }, this.sampleMs);
    this.timer.unref?.();
  }

  snapshot() {
    const position = this.bot?.entity?.position;
    const pingMs = Number(this.bot?.player?.ping);
    return {
      tps: this.tps,
      pingMs: Number.isFinite(pingMs) && pingMs >= 0 ? Math.round(pingMs) : null,
      position: position && [position.x, position.y, position.z].every(Number.isFinite)
        ? { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10, z: Math.round(position.z * 10) / 10 }
        : null,
      dimension: String(this.bot?.game?.dimension || '').slice(0, 40) || null
    };
  }

  detach() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.bot) this.bot.removeListener('physicsTick', this.onPhysicsTick);
    this.bot = null;
    this.ticks = 0;
    this.tps = null;
  }
}

module.exports = ServerMonitor;
