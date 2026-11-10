'use strict';

class AfkController {
  constructor({ logger } = {}) {
    this.mode = 'still';
    this.logger = logger;
    this.bot = null;
    this.active = false;
    this.antiAfkTimer = null;
    this.onHealth = null;
    this.onInventorySlotUpdate = null;
    this.onHeldItemChanged = null;
  }

  checkAndEquipOffhandTotem() {
    if (!this.bot || !this.bot.inventory) return;
    try {
      const slots = this.bot.inventory.slots;
      // Slot 45 is the designated off-hand slot in Minecraft 1.9+
      const offhandItem = slots?.[45];
      if (offhandItem && (offhandItem.name === 'totem_of_undying' || String(offhandItem.name).includes('totem'))) {
        return; // Already holding Totem in off-hand
      }

      // Find Totem in main inventory
      const totem = this.bot.inventory.items().find((it) => it && (it.name === 'totem_of_undying' || String(it.name).includes('totem')));
      if (!totem) return;

      if (typeof this.bot.equip === 'function') {
        this.bot.equip(totem, 'off-hand').then(() => {
          this.logger?.debug?.('totem_equipped_offhand_success');
        }).catch((err) => {
          this.logger?.debug?.('totem_equip_retry_scheduled', { error: err.message });
        });
      }
    } catch (_) {}
  }

  scheduleAntiAfkAction() {
    if (!this.active || !this.bot) return;
    if (this.antiAfkTimer) clearTimeout(this.antiAfkTimer);

    // Random interval between 25 and 45 seconds to bypass server-side heuristics
    const intervalMs = Math.floor(Math.random() * 20000) + 25000;
    this.antiAfkTimer = setTimeout(() => {
      this.performMicroLookAndSwing();
      this.scheduleAntiAfkAction();
    }, intervalMs);
    this.antiAfkTimer.unref?.();
  }

  performMicroLookAndSwing() {
    if (!this.active || !this.bot) return;
    try {
      if (this.bot.entity) {
        const yaw = Number(this.bot.entity.yaw) || 0;
        const pitch = Number(this.bot.entity.pitch) || 0;
        // Micro-rotation (+/- 0.05 radians ~ 2.8 degrees) without triggering physics lag
        const deltaYaw = (Math.random() * 0.1 - 0.05);
        if (typeof this.bot.look === 'function') {
          this.bot.look(yaw + deltaYaw, pitch, true).catch?.(() => {});
        }
        if (typeof this.bot.swingArm === 'function') {
          this.bot.swingArm('right');
        }
      }
    } catch (_) {}
  }

  freezePhysics() {
    if (this.bot) {
      try { this.bot.physicsEnabled = false; } catch (_) {}
    }
  }

  unfreezePhysics() {
    if (this.bot) {
      try { this.bot.physicsEnabled = true; } catch (_) {}
    }
  }

  start(bot) {
    this.stop();
    if (!bot) return;
    this.bot = bot;
    this.active = true;

    // Fast reaction listeners (< 50ms)
    this.onHealth = () => this.checkAndEquipOffhandTotem();
    this.onInventorySlotUpdate = (slot) => {
      if (slot === 45 || slot === 40 || !slot) {
        this.checkAndEquipOffhandTotem();
      }
    };
    this.onHeldItemChanged = () => this.checkAndEquipOffhandTotem();

    bot.on('health', this.onHealth);
    if (bot.inventory?.on) {
      bot.inventory.on('updateSlot', this.onInventorySlotUpdate);
    }
    bot.on('heldItemChanged', this.onHeldItemChanged);

    // Initial reflex check
    this.checkAndEquipOffhandTotem();

    // Start anti-AFK micro-rotation schedule
    this.scheduleAntiAfkAction();

    // Disable physics calculations to lock CPU usage close to 0%
    this.freezePhysics();
  }

  stop() {
    this.active = false;
    if (this.antiAfkTimer) {
      clearTimeout(this.antiAfkTimer);
      this.antiAfkTimer = null;
    }
    if (this.bot) {
      if (this.onHealth) {
        try { this.bot.removeListener('health', this.onHealth); } catch (_) {}
      }
      if (this.onHeldItemChanged) {
        try { this.bot.removeListener('heldItemChanged', this.onHeldItemChanged); } catch (_) {}
      }
      if (this.onInventorySlotUpdate && this.bot.inventory?.removeListener) {
        try { this.bot.inventory.removeListener('updateSlot', this.onInventorySlotUpdate); } catch (_) {}
      }
      try { this.bot.setControlState?.('sneak', false); } catch (_) {}
      this.unfreezePhysics();
    }
    this.bot = null;
    this.onHealth = null;
    this.onInventorySlotUpdate = null;
    this.onHeldItemChanged = null;
  }
}

module.exports = AfkController;
