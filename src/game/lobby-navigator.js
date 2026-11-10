'use strict';

const { isRestrictedMinecraftCommand, cleanText, getLocationKind } = require('./server-auth');

function isMenuSelectorItem(item) {
  if (!item) return false;
  const name = String(item.name || '').toLowerCase();
  const displayName = String(item.displayName || '').toLowerCase();
  const customName = String(item.customName || '').toLowerCase();
  return (
    name.includes('clock') ||
    name.includes('compass') ||
    name.includes('watch') ||
    name.includes('star') ||
    name.includes('menu') ||
    displayName.includes('máy chủ') ||
    displayName.includes('may chu') ||
    displayName.includes('server') ||
    displayName.includes('menu') ||
    customName.includes('máy chủ') ||
    customName.includes('may chu') ||
    customName.includes('server') ||
    customName.includes('menu')
  );
}

function findMenuSelectorSlot(bot) {
  if (!bot || !bot.inventory) return -1;
  const held = bot.heldItem;
  if (held && isMenuSelectorItem(held)) {
    return typeof bot.quickBarSlot === 'number' ? bot.quickBarSlot : 0;
  }
  for (let i = 0; i < 9; i++) {
    const item = bot.inventory.slots && bot.inventory.slots[36 + i];
    if (item && isMenuSelectorItem(item)) {
      return i;
    }
  }
  return -1;
}

class LobbyNavigator {
  constructor({ joinCommand = '', joinDelayMs = 4000, logger }) {
    this.joinCommand = joinCommand;
    this.joinDelayMs = joinDelayMs;
    this.logger = logger;
    this.state = 'IDLE'; // FSM: IDLE -> SELECT_COMPASS_SLOT -> USE_COMPASS -> WAIT_MENU_WINDOW -> CLICK_TARGET_SERVER_SLOT -> VERIFY_AFK_ZONE
    this.timer = null;
    this.bot = null;
    this.lastJoinAt = 0;
    this.serverJoinBusy = false;
    this.serverJoinAttempts = 0;
    this.pendingMenuListener = null;
    this.pendingMenuCleanup = null;
    this.menuCommandIndex = 0;
    this.retryTimer = null;
    this.chatTimer = null;
  }

  transitionTo(newState, context = {}) {
    const prev = this.state;
    this.state = newState;
    if (this.logger?.debug) {
      this.logger.debug('lobby_fsm_transition', { from: prev, to: newState, ...context });
    }
  }

  onSpawn(bot) {
    this.bot = bot;
    this.clear();
    this.transitionTo('IDLE');
    // Schedule initial check/join after spawn
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tryJoin(bot);
    }, Math.max(1500, this.joinDelayMs));
  }

  tryJoin(bot) {
    if (!bot || this.serverJoinBusy) return;
    const kind = getLocationKind(bot);
    if (kind === 'other') {
      this.transitionTo('IDLE', { reason: 'already_in_game' });
      return; // Already in game
    }

    if (this.joinCommand) {
      if (Date.now() - this.lastJoinAt < 3000) return;
      this.lastJoinAt = Date.now();
      const cmd = this.joinCommand.startsWith('/') ? this.joinCommand : `/${this.joinCommand}`;
      if (isRestrictedMinecraftCommand(cmd)) {
        this.logger.warn('lobby_join_command_blocked');
        return;
      }
      try {
        bot.chat(cmd);
        this.logger.info('lobby_join_command_sent', { command: cmd });
      } catch (error) {
        this.logger.warn('lobby_join_command_failed', { code: error?.code || 'send_failed' });
      }
      return;
    }

    // Default KingMC Flow: Open Menu & Click Slot 24 (KingSMP)
    this.triggerServerJoin(bot, 'spawn_routine');
  }

  triggerServerJoin(bot, source = 'routine') {
    if (!bot || this.serverJoinBusy) return;
    const kind = getLocationKind(bot);
    if (kind === 'other') {
      this.transitionTo('IDLE', { reason: 'already_in_game' });
      return;
    }

    this.serverJoinBusy = true;
    this.serverJoinAttempts += 1;
    this.lastJoinAt = Date.now();
    this.logger.info('lobby_server_join_triggered', { source, attempt: this.serverJoinAttempts });

    let clicked = false;
    const doClickSlot24 = (window) => {
      if (clicked || this.bot !== bot) return;
      clicked = true;
      this.clearMenuListener(bot);
      this.transitionTo('CLICK_TARGET_SERVER_SLOT');

      setTimeout(() => {
        if (this.bot !== bot) return;
        const targetWindow = bot.currentWindow || window;
        if (targetWindow) {
          try {
            if (Array.isArray(targetWindow.slots) && targetWindow.slots.length <= 24) {
              this.logger.warn('lobby_menu_missing_slot_24', { totalSlots: targetWindow.slots.length });
              this.serverJoinBusy = false;
              this.transitionTo('IDLE', { reason: 'missing_slot_24' });
              return;
            }
            this.logger.info('lobby_menu_clicking_slot_24', { slot: 24, target: 'KingSMP' });
            bot.clickWindow(24, 0, 0);
            this.transitionTo('VERIFY_AFK_ZONE');
          } catch (clickErr) {
            this.logger.warn('lobby_menu_click_failed', { error: clickErr.message });
          } finally {
            setTimeout(() => {
              this.serverJoinBusy = false;
              if (getLocationKind(bot) === 'other') {
                this.transitionTo('IDLE', { verified: true });
              }
            }, 2000);
          }
        } else {
          this.serverJoinBusy = false;
          this.transitionTo('IDLE');
        }
      }, 300);
    };

    if (bot.currentWindow) {
      doClickSlot24(bot.currentWindow);
    } else {
      this.transitionTo('WAIT_MENU_WINDOW');
      this.pendingMenuListener = (win) => doClickSlot24(win);
      bot.once('windowOpen', this.pendingMenuListener);
      this.pendingMenuCleanup = setTimeout(() => {
        this.clearMenuListener(bot);
        this.serverJoinBusy = false;
        if (this.state === 'WAIT_MENU_WINDOW') {
          this.transitionTo('IDLE', { reason: 'menu_window_timeout' });
        }
      }, 5000);
    }

    // 1. Right-click selector item in hotbar
    this.transitionTo('SELECT_COMPASS_SLOT');
    try {
      const selectorSlot = findMenuSelectorSlot(bot);
      if (selectorSlot >= 0 && typeof bot.setQuickBarSlot === 'function') {
        try { bot.setQuickBarSlot(selectorSlot); } catch (_) {}
      }
      this.transitionTo('USE_COMPASS');
      if (typeof bot.activateItem === 'function') {
        bot.activateItem();
        this.logger.info('lobby_selector_item_activated');
      }
    } catch (actErr) {
      this.logger.warn('lobby_selector_item_activate_failed', { error: actErr.message });
    }

    // 2. Chat fallback (/menu or /gui)
    const menuCommands = ['/menu', '/gui'];
    const cmd = menuCommands[this.menuCommandIndex % menuCommands.length];
    this.menuCommandIndex = (this.menuCommandIndex + 1) % menuCommands.length;

    this.chatTimer = setTimeout(() => {
      this.chatTimer = null;
      if (this.bot !== bot || clicked) return;
      if (getLocationKind(bot) === 'other') return;
      try {
        bot.chat(cmd);
        this.logger.info('lobby_fallback_command_sent', { command: cmd });
      } catch (_) {}
    }, 400);

    // 3. Retry loop (up to 5 attempts)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.bot !== bot) return;
      const currentKind = getLocationKind(bot);
      if (currentKind === 'other') {
        this.serverJoinAttempts = 0;
        this.serverJoinBusy = false;
        this.transitionTo('IDLE', { verified: true });
        return;
      }
      if (this.serverJoinAttempts < 5) {
        this.serverJoinBusy = false;
        this.triggerServerJoin(bot, `retry_${this.serverJoinAttempts}`);
      } else {
        this.logger.warn('lobby_server_join_exhausted', { attempts: this.serverJoinAttempts });
        this.serverJoinBusy = false;
        this.transitionTo('IDLE', { reason: 'exhausted' });
      }
    }, 3500);
  }

  clearMenuListener(bot = this.bot) {
    if (this.pendingMenuCleanup) clearTimeout(this.pendingMenuCleanup);
    this.pendingMenuCleanup = null;
    if (this.pendingMenuListener && bot) {
      try { bot.removeListener('windowOpen', this.pendingMenuListener); } catch (_) {}
    }
    this.pendingMenuListener = null;
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.chatTimer) clearTimeout(this.chatTimer);
    this.timer = null;
    this.retryTimer = null;
    this.chatTimer = null;
    this.clearMenuListener(this.bot);
    this.serverJoinBusy = false;
    this.serverJoinAttempts = 0;
    this.state = 'IDLE';
    this.bot = null;
  }
}

module.exports = LobbyNavigator;
