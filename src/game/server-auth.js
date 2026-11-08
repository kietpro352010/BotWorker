'use strict';

function cleanText(input) {
  return String(input || '').replace(/§[0-9a-fk-or]/gi, '').replace(/[\u00a0\u200b\ufeff]/g, ' ').normalize('NFC').trim();
}

function normalize(input) {
  return cleanText(input).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
}

function isRestrictedMinecraftCommand(value) {
  return /^\/\s*(?:[a-z0-9_-]+:)?(?:register|login|changepassword|changepass|password|unregister|email)\b/i.test(String(value || '').trim());
}

class ServerAuth {
  constructor({ password, enabled = true, logger }) {
    this.password = password;
    this.enabled = enabled;
    this.logger = logger;
    this.lastActionAt = 0;
  }

  handleMessage(bot, message) {
    if (!this.enabled || !this.password || !bot) return false;
    const text = normalize(message);
    const isRegister = /(?:^|\s)\/(?:register|dk)\b/.test(text)
      || /(?:please|you must|first|hay|vui long|ban can|can) .{0,32}(?:register|dang ky)/.test(text)
      || /(?:register|dang ky).{0,32}(?:account|tai khoan|before|first|de tiep tuc)/.test(text);
    const isLogin = /(?:^|\s)\/(?:login|dn)\b/.test(text)
      || /(?:please|you must|first|hay|vui long|ban can|can) .{0,32}(?:log in|login|dang nhap)/.test(text)
      || /(?:log in|login|dang nhap).{0,32}(?:account|tai khoan|before|first|de tiep tuc)/.test(text);
    if (!isRegister && !isLogin) return false;
    if (Date.now() - this.lastActionAt < 3000) return true;
    const command = isRegister
      ? `/register ${this.password} ${this.password}`
      : `/login ${this.password}`;
    this.lastActionAt = Date.now();
    this.logger.info('minecraft_auth_prompt_detected', { kind: isRegister ? 'register' : 'login' });
    try { bot.chat(command); }
    catch (error) { this.logger.warn('minecraft_auth_send_failed', { kind: isRegister ? 'register' : 'login', code: error?.code || 'send_failed' }); }
    return true;
  }
}

module.exports = { ServerAuth, cleanText, normalize, isRestrictedMinecraftCommand };

