'use strict';

class AfkController {
  constructor({ logger, minMs, maxMs } = {}) {
    this.mode = 'still';
    this.logger = logger;
    const parsedMin = Number(minMs);
    const parsedMax = Number(maxMs);
    this.minMs = Number.isFinite(parsedMin) && parsedMin >= 1000 ? parsedMin : 25000;
    this.maxMs = Number.isFinite(parsedMax) && parsedMax >= this.minMs ? parsedMax : Math.max(this.minMs, 45000);
    this.bot = null;
    this.active = false;
    this.antiAfkTimer = null;
  }

  scheduleAntiAfkAction() {
    if (!this.active || !this.bot) return;
    if (this.antiAfkTimer) clearTimeout(this.antiAfkTimer);

    const spanMs = Math.max(0, this.maxMs - this.minMs);
    const intervalMs = this.minMs + Math.floor(Math.random() * (spanMs + 1));
    this.antiAfkTimer = setTimeout(() => {
      this.performMicroLookAndSwing();
      this.scheduleAntiAfkAction();
    }, intervalMs);
    this.antiAfkTimer.unref?.();
  }

  performMicroLookAndSwing() {
    if (!this.active || !this.bot || this.bot._kbotEnded || this.bot.currentWindow) return;
    try {
      if (this.bot.entity) {
        const yaw = Number(this.bot.entity.yaw) || 0;
        const pitch = Number(this.bot.entity.pitch) || 0;
        // Micro-rotation (+/- 0.05 radians ~ 2.8 degrees) without triggering physics lag
        const deltaYaw = (Math.random() * 0.1 - 0.05);
        if (typeof this.bot.look === 'function') {
          Promise.resolve(this.bot.look(yaw + deltaYaw, pitch, true)).catch(() => {});
        }
        if (typeof this.bot.swingArm === 'function') {
          this.bot.swingArm('right');
        }
      }
    } catch (_) {}
  }

  start(bot) {
    this.stop();
    if (!bot) return;
    this.bot = bot;
    this.active = true;

    // Start anti-AFK micro-rotation schedule
    this.scheduleAntiAfkAction();
  }

  stop() {
    this.active = false;
    if (this.antiAfkTimer) {
      clearTimeout(this.antiAfkTimer);
      this.antiAfkTimer = null;
    }
    if (this.bot) {
      try { this.bot.setControlState?.('sneak', false); } catch (_) {}
    }
    this.bot = null;
  }
}

module.exports = AfkController;
