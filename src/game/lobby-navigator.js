'use strict';

const { isRestrictedMinecraftCommand } = require('./server-auth');

class LobbyNavigator {
  constructor({ joinCommand = '', joinDelayMs = 4000, logger }) {
    this.joinCommand = joinCommand;
    this.joinDelayMs = joinDelayMs;
    this.logger = logger;
    this.timer = null;
    this.bot = null;
    this.lastJoinAt = 0;
  }

  onSpawn(bot) {
    this.bot = bot;
    if (!this.joinCommand) return;
    this.clear();
    this.timer = setTimeout(() => this.tryJoin(bot), this.joinDelayMs);
  }

  tryJoin(bot) {
    if (!bot || Date.now() - this.lastJoinAt < 3000) return;
    this.lastJoinAt = Date.now();
    if (isRestrictedMinecraftCommand(this.joinCommand.startsWith('/') ? this.joinCommand : `/${this.joinCommand}`)) {
      this.logger.warn('lobby_join_command_blocked');
      return;
    }
    try {
      bot.chat(this.joinCommand.startsWith('/') ? this.joinCommand : `/${this.joinCommand}`);
      this.logger.info('lobby_join_command_sent');
    } catch (error) {
      this.logger.warn('lobby_join_command_failed', { code: error?.code || 'send_failed' });
    }
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.bot = null;
  }
}

module.exports = LobbyNavigator;

