'use strict';

const { isRestrictedMinecraftCommand, getLocationKind, redactAuditValue } = require('./server-auth');

function applyCommandJitterMs(baseMs, maxOffsetMs = 5000, minFloorMs = 800) {
  const base = Math.max(0, Number(baseMs) || 0);
  const offset = Math.floor((Math.random() * 2 - 1) * maxOffsetMs);
  return Math.max(minFloorMs, base + offset);
}

function waitForGuiUpdate(bot, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let isResolved = false;
    let debounceTimer = null;
    let timeoutTimer = null;
    let targetWindow = bot.currentWindow || null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      try { bot.removeListener('windowOpen', onWindowOpen); } catch (_) {}
      if (targetWindow && typeof targetWindow.removeListener === 'function') {
        try { targetWindow.removeListener('updateSlot', onSlotUpdate); } catch (_) {}
      }
      if (bot.currentWindow && bot.currentWindow !== targetWindow && typeof bot.currentWindow.removeListener === 'function') {
        try { bot.currentWindow.removeListener('updateSlot', onSlotUpdate); } catch (_) {}
      }
    };

    const done = () => {
      if (isResolved) return;
      isResolved = true;
      cleanup();
      resolve(bot.currentWindow || null);
    };

    timeoutTimer = setTimeout(() => {
      done();
    }, timeoutMs);
    timeoutTimer.unref?.();

    const onWindowOpen = (win) => {
      if (targetWindow && targetWindow !== win && typeof targetWindow.removeListener === 'function') {
        try { targetWindow.removeListener('updateSlot', onSlotUpdate); } catch (_) {}
      }
      if (win && typeof win.on === 'function') {
        targetWindow = win;
        try { win.on('updateSlot', onSlotUpdate); } catch (_) {}
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(done, 150);
      debounceTimer.unref?.();
    };

    const onSlotUpdate = (slot) => {
      if (slot >= 0 && slot < 45) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(done, 150);
        debounceTimer.unref?.();
      }
    };

    if (typeof bot.once === 'function') {
      bot.once('windowOpen', onWindowOpen);
    }
    if (bot.currentWindow && typeof bot.currentWindow.on === 'function') {
      targetWindow = bot.currentWindow;
      bot.currentWindow.on('updateSlot', onSlotUpdate);
    }
  });
}

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
  constructor({ joinCommand = '', joinDelayMs = 7000, logger, isAuthenticated = () => true } = {}) {
    this.joinCommand = joinCommand;
    this.isAuthenticated = isAuthenticated;
    this.joinDelayMs = joinDelayMs;
    this.logger = logger;
    this.state = 'IDLE'; // FSM: IDLE -> SELECT_COMPASS -> USE_COMPASS -> WAIT_MENU -> CLICK_SERVER -> AFK_LOCKED
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
    this.postJoinTimer = null;
    this.clickTimer = null;
    this.clickInProgress = false;
    this.lastWaitLogAt = 0;
    this.lastExhaustedAt = 0;
  }

  transitionTo(newState, context = {}) {
    const prev = this.state;
    this.state = newState;
    if (this.logger?.debug) {
      this.logger.debug('lobby_fsm_transition', { from: prev, to: newState, ...context });
    }
  }

  onSpawn(bot) {
    this.clear();
    this.bot = bot;
    this.transitionTo('IDLE');
    // Schedule initial check/join after spawn with ±5s anti-cheat jitter around joinDelayMs
    const baseDelayMs = Math.max(1500, Number(this.joinDelayMs) || 5000);
    const delayMs = applyCommandJitterMs(baseDelayMs, 5000, 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tryJoin(bot);
    }, delayMs);
    this.timer.unref?.();
  }

  isReadyForNavigation(bot, source) {
    if (!bot) return false;
    if (!this.isAuthenticated()) {
      if (Date.now() - this.lastWaitLogAt >= 15000) {
        this.lastWaitLogAt = Date.now();
        this.logger.info('lobby_navigation_waiting_for_auth', { source });
      }
      return false;
    }
    const kind = getLocationKind(bot);
    if (kind === 'other') {
      this.transitionTo('IDLE', { reason: 'already_in_game' });
      return false;
    }
    if (kind !== 'lobby') {
      if (Date.now() - this.lastWaitLogAt >= 15000) {
        this.lastWaitLogAt = Date.now();
        this.logger.info('lobby_navigation_waiting_for_lobby', { source, location: kind });
      }
      return false;
    }
    return true;
  }

  tryJoin(bot) {
    if (!bot || this.serverJoinBusy) return;
    if (this.serverJoinAttempts >= 3 && Date.now() - this.lastExhaustedAt < 30000) return;
    if (Date.now() - this.lastExhaustedAt >= 30000) this.serverJoinAttempts = 0;
    this.bot = bot;
    if (!this.isReadyForNavigation(bot, 'try_join')) return;

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
        this.logger.info('lobby_join_command_sent', { command: redactAuditValue(cmd) });
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
    if (this.serverJoinAttempts >= 3 && Date.now() - this.lastExhaustedAt < 30000) return;
    if (!this.isReadyForNavigation(bot, source)) return;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.chatTimer) {
      clearTimeout(this.chatTimer);
      this.chatTimer = null;
    }
    this.clearMenuListener(bot);

    this.serverJoinBusy = true;
    this.serverJoinAttempts += 1;
    this.lastJoinAt = Date.now();
    this.logger.info('lobby_server_join_triggered', { source, attempt: this.serverJoinAttempts });

    let clicked = false;
    const scheduleJoinVerification = (deadline) => {
      const verify = () => {
        this.postJoinTimer = null;
        if (this.bot !== bot) return;
        const kind = getLocationKind(bot);
        if (kind === 'other') {
          this.serverJoinBusy = false;
          this.serverJoinAttempts = 0;
          this.transitionTo('AFK_LOCKED', { verified: true });
          return;
        }
        if (!this.isAuthenticated()) {
          this.serverJoinBusy = false;
          this.transitionTo('IDLE', { reason: 'authentication_lost' });
          return;
        }
        if (Date.now() < deadline) {
          this.postJoinTimer = setTimeout(verify, 400);
          this.postJoinTimer.unref?.();
          return;
        }
        this.serverJoinBusy = false;
        this.transitionTo('IDLE', { reason: 'join_not_confirmed' });
        if (kind === 'lobby' && this.serverJoinAttempts < 3) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.triggerServerJoin(bot, `retry_after_unconfirmed_${this.serverJoinAttempts}`);
          }, 1000);
          this.retryTimer.unref?.();
        } else if (kind === 'lobby' && this.serverJoinAttempts >= 3) {
          this.lastExhaustedAt = Date.now();
        }
      };
      if (this.postJoinTimer) clearTimeout(this.postJoinTimer);
      this.postJoinTimer = setTimeout(verify, 400);
      this.postJoinTimer.unref?.();
    };

    const doClickSlot24 = async (window) => {
      if (clicked || this.bot !== bot) return;
      if (!this.isReadyForNavigation(bot, 'menu_click')) {
        this.serverJoinBusy = false;
        return;
      }
      clicked = true;
      this.clickInProgress = true;
      this.clearMenuListener(bot);
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.transitionTo('CLICK_SERVER');
      this.clickTimer = setTimeout(async () => {
        this.clickTimer = null;
        if (this.bot !== bot) return;
        if (!this.isReadyForNavigation(bot, 'menu_click')) {
          this.clickInProgress = false;
          this.serverJoinBusy = false;
          return;
        }
        const targetWindow = bot.currentWindow || window;
        if (!targetWindow) {
          this.clickInProgress = false;
          this.serverJoinBusy = false;
          this.transitionTo('IDLE', { reason: 'menu_window_missing' });
          return;
        }
        if (Array.isArray(targetWindow.slots) && targetWindow.slots.length <= 24) {
          this.logger.warn('lobby_menu_missing_slot_24', { totalSlots: targetWindow.slots.length });
          this.clickInProgress = false;
          this.serverJoinBusy = false;
          try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (_) {}
          this.transitionTo('IDLE', { reason: 'missing_slot_24' });
          return;
        }
        try {
          this.logger.info('lobby_menu_clicking_slot_24', { slot: 24, target: 'KingSMP' });
          await bot.clickWindow(24, 0, 0);
          if (this.bot !== bot) return;
          scheduleJoinVerification(Date.now() + 6000);
        } catch (clickErr) {
          if (this.bot !== bot) return;
          this.logger.warn('lobby_menu_click_failed', { error: clickErr?.message || 'click_failed' });
          this.serverJoinBusy = false;
          this.transitionTo('IDLE', { reason: 'click_failed' });
          if (this.serverJoinAttempts < 3 && this.isReadyForNavigation(bot, 'click_retry')) {
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              this.triggerServerJoin(bot, `retry_after_click_error_${this.serverJoinAttempts}`);
            }, 1000);
            this.retryTimer.unref?.();
          }
        } finally {
          if (this.bot === bot) this.clickInProgress = false;
        }
      }, 300);
      this.clickTimer.unref?.();
    };

    if (bot.currentWindow) {
      doClickSlot24(bot.currentWindow);
    } else {
      this.transitionTo('WAIT_MENU');
      this.pendingMenuListener = (win) => doClickSlot24(win);
      bot.once('windowOpen', this.pendingMenuListener);
      this.pendingMenuCleanup = setTimeout(() => {
        if (this.bot !== bot) return;
        this.clearMenuListener(bot);
        this.serverJoinBusy = false;
        try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (_) {}
        if (this.serverJoinAttempts < 3) {
          this.triggerServerJoin(bot, `retry_after_timeout_${this.serverJoinAttempts}`);
        } else {
          this.lastExhaustedAt = Date.now();
          if (this.state === 'WAIT_MENU') {
            this.transitionTo('IDLE', { reason: 'menu_window_timeout' });
          }
        }
      }, 5000);
      this.pendingMenuCleanup.unref?.();

      // 1. Right-click selector item in hotbar
      this.transitionTo('SELECT_COMPASS');
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
        if (this.bot !== bot || clicked || !this.isReadyForNavigation(bot, 'fallback_command')) return;
        try {
          bot.chat(cmd);
          this.logger.info('lobby_fallback_command_sent', { command: cmd });
        } catch (_) {}
      }, 400);
      this.chatTimer.unref?.();

      // 3. Retry loop (up to 3 attempts)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.bot !== bot) return;
        if (this.clickInProgress || this.postJoinTimer) return;
        const currentKind = getLocationKind(bot);
        if (currentKind === 'other') {
          this.clearMenuListener(bot);
          this.serverJoinAttempts = 0;
          this.serverJoinBusy = false;
          this.transitionTo('AFK_LOCKED', { verified: true });
          return;
        }
        if (!this.isReadyForNavigation(bot, 'retry')) {
          this.clearMenuListener(bot);
          this.serverJoinBusy = false;
          return;
        }
        if (this.serverJoinAttempts < 3) {
          this.serverJoinBusy = false;
          try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch (_) {}
          this.triggerServerJoin(bot, `retry_${this.serverJoinAttempts}`);
        } else {
          this.clearMenuListener(bot);
          this.lastExhaustedAt = Date.now();
          this.logger.warn('lobby_server_join_exhausted', { attempts: this.serverJoinAttempts });
          this.serverJoinBusy = false;
          this.transitionTo('IDLE', { reason: 'exhausted' });
        }
      }, 3500);
      this.retryTimer.unref?.();
    }
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
    if (this.postJoinTimer) clearTimeout(this.postJoinTimer);
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.timer = null;
    this.retryTimer = null;
    this.chatTimer = null;
    this.postJoinTimer = null;
    this.clickTimer = null;
    this.clickInProgress = false;
    this.clearMenuListener(this.bot);
    this.serverJoinBusy = false;
    this.serverJoinAttempts = 0;
    this.lastExhaustedAt = 0;
    this.state = 'IDLE';
    this.bot = null;
  }
}

module.exports = LobbyNavigator;
module.exports.waitForGuiUpdate = waitForGuiUpdate;
module.exports.applyCommandJitterMs = applyCommandJitterMs;
