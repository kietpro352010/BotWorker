'use strict';

const AUTH_COORDS = Object.freeze({ x: 5, y: 119, z: 4 });
const LOBBY_COORDS = Object.freeze({ x: 1, y: 41, z: 1 });

function cleanText(input) {
  return String(input || '')
    .replace(/§x(§[0-9a-f]){6}/gi, '')
    .replace(/&x(&[0-9a-f]){6}/gi, '')
    .replace(/&#[0-9a-f]{6}/gi, '')
    .replace(/§#[0-9a-f]{6}/gi, '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/&[0-9a-fk-or]/gi, '')
    .replace(/§./g, '')
    .replace(/[\u00a0\u200b\ufeff]/g, ' ')
    .normalize('NFC')
    .trim();
}

function extractChatMessage(raw) {
  if (!raw) return '';
  if (typeof raw === 'object' && typeof raw.toPlainText === 'function') {
    return cleanText(raw.toPlainText());
  }
  let str = typeof raw === 'string' ? raw : '';
  if (!str && typeof raw === 'object') {
    try { str = JSON.stringify(raw); } catch (_) { str = String(raw); }
  }
  try {
    const obj = typeof raw === 'object' ? raw : JSON.parse(str);
    const walk = (node) => {
      if (!node) return '';
      if (typeof node === 'string') return node;
      let text = node.text || '';
      if (Array.isArray(node.extra)) {
        text += node.extra.map(walk).join('');
      }
      return text;
    };
    const res = walk(obj);
    if (res) return cleanText(res);
  } catch (_) {}
  return cleanText(str);
}

function normalize(input) {
  return cleanText(input).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
}

function isRestrictedMinecraftCommand(value) {
  return /^\/\s*(?:[a-z0-9_-]+:)?(?:register|login|changepassword|changepass|password|unregister|email)\b/i.test(String(value || '').trim());
}

function inRadius(pos, target, radiusXZ = 2.5, radiusY = 3.0) {
  if (!pos || !target) return false;
  const x = Number(pos.x);
  const y = Number(pos.y);
  const z = Number(pos.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  const dx = Math.abs(x - target.x);
  const dy = Math.abs(y - target.y);
  const dz = Math.abs(z - target.z);
  return (dx * dx + dz * dz <= radiusXZ * radiusXZ) && (dy <= radiusY);
}

function getLocationKind(bot) {
  const pos = bot?.entity?.position;
  if (!pos) return 'unknown';
  if (inRadius(pos, AUTH_COORDS)) return 'login';
  if (inRadius(pos, LOBBY_COORDS)) return 'lobby';
  return 'other';
}

function isVerificationSuccessNotice(message) {
  const text = normalize(message);
  return /xac minh thanh cong|vui long vao lai server de bat dau choi/i.test(text);
}

class ServerAuth {
  constructor({ password, enabled = true, logger }) {
    this.password = password;
    this.enabled = enabled;
    this.logger = logger;
    this.lastActionAt = 0;
    this.lastAuthDnActionAt = 0;
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

  sendDirectAuth(bot, kind = 'login') {
    if (!this.enabled || !this.password || !bot) return false;
    const now = Date.now();
    if (now - this.lastActionAt < 2000) return false;
    this.lastActionAt = now;
    const command = kind === 'dn' ? `/dn ${this.password}` : `/login ${this.password}`;
    this.logger.info('minecraft_direct_auth_sent', { kind });
    try {
      bot.chat(command);
      return true;
    } catch (error) {
      this.logger.warn('minecraft_direct_auth_failed', { kind, code: error?.code || 'send_failed' });
      return false;
    }
  }
}

module.exports = {
  ServerAuth,
  cleanText,
  extractChatMessage,
  normalize,
  isRestrictedMinecraftCommand,
  AUTH_COORDS,
  LOBBY_COORDS,
  inRadius,
  getLocationKind,
  isVerificationSuccessNotice
};
