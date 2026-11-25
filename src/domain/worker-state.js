'use strict';

const STATES = Object.freeze([
  'stopped',
  'starting',
  'stopping',
  'connecting',
  'reconnecting',
  'authenticating',
  'entering',
  'online',
  'afk',
  'afk_locked',
  'maintenance',
  'ip_limited',
  'banned',
  'error'
]);

function normalizeState(state) {
  return STATES.includes(state) ? state : 'error';
}

function fastHexDigest64(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function computeBotStateDigest(status = {}) {
  if (!status || typeof status !== 'object') status = {};
  const stateStr = String(status.state || status.status || 'unknown');
  const health = Math.round(Number(status.health) || 0);
  const food = Math.round(Number(status.food) || 0);
  const totems = Number(status.totemCount || 0);
  const loc = String(status.locationState || status.locationKind || 'unknown');
  const dim = String(status.dimension || '');
  const pingBucket = Math.round((Number(status.pingMs) || 0) / 25) * 25;
  const err = String(status.lastError || status.lastKickReason || '');
  const restriction = String(status.restriction || '');
  const username = String(status.username || '');
  const manuallyStopped = status.manuallyStopped ? '1' : '0';
  const invRev = status.inventory?.revision ?? 0;
  const winSig = status.currentWindow
    ? `${status.currentWindow.title || ''}:${Array.isArray(status.currentWindow.slots) ? status.currentWindow.slots.length : 0}:${status.currentWindow.revision || 0}`
    : '';

  const payload = `${stateStr}|${health}|${food}|${totems}|${loc}|${dim}|${pingBucket}|${err}|${restriction}|${username}|${manuallyStopped}|${invRev}|${winSig}`;
  return fastHexDigest64(payload);
}

class CircularLogBuffer {
  constructor(capacity = 100) {
    const capNum = Number(capacity);
    this.capacity = Number.isInteger(capNum) && capNum > 0 && Number.isFinite(capNum) ? capNum : 100;
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
    this.logSeq = 0;
  }

  push(item) {
    this.logSeq++;
    const entry = typeof item === 'object' && item !== null && !Array.isArray(item)
      ? { ...item, seq: this.logSeq, loggedAt: item.loggedAt || new Date().toISOString() }
      : { seq: this.logSeq, message: Array.isArray(item) ? JSON.stringify(item) : String(item), loggedAt: new Date().toISOString() };

    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    return entry;
  }

  getAll() {
    if (this.size === 0) return [];
    const result = new Array(this.size);
    const start = this.size < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.size; i++) {
      result[i] = this.buffer[(start + i) % this.capacity];
    }
    return result;
  }

  getSince(lastAckedLogSeq = 0) {
    if (this.size === 0 || lastAckedLogSeq >= this.logSeq) return [];
    return this.getAll().filter((entry) => entry && entry.seq > lastAckedLogSeq);
  }

  latestSeq() {
    return this.logSeq;
  }

  clear() {
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}

module.exports = {
  STATES,
  normalizeState,
  computeBotStateDigest,
  CircularLogBuffer
};
