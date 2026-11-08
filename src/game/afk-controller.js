'use strict';

class AfkController {
  constructor({ logger } = {}) {
    this.mode = 'still';
    this.logger = logger;
    this.bot = null;
  }

  start(bot) {
    this.stop();
    this.bot = bot;
    // Mode is permanently locked to 'still'. No random movement, looking or sneaking.
  }

  stop() {
    if (this.bot) {
      try { this.bot.setControlState('sneak', false); } catch (_) {}
    }
    this.bot = null;
  }
}

module.exports = AfkController;

