'use strict';

const crypto = require('node:crypto');

const STATES = Object.freeze([
  'stopped',
  'connecting',
  'authenticating',
  'entering',
  'online',
  'maintenance',
  'ip_limited',
  'banned',
  'error'
]);

function normalizeState(state) {
  return STATES.includes(state) ? state : 'error';
}

function computeBotStateDigest(status = {}) {
  const stateStr = String(status.state || status.status || 'unknown');
  const health = Math.round(Number(status.health) || 0);
  const food = Math.round(Number(status.food) || 0);
  const totems = Number(status.totemCount || 0);
  const loc = String(status.locationKind || 'unknown');
  const pingBucket = Math.round((Number(status.pingMs) || 0) / 25) * 25;
  const err = String(status.lastError || status.lastKickReason || '');
  const restriction = String(status.restriction || '');

  const payload = `${stateStr}|${health}|${food}|${totems}|${loc}|${pingBucket}|${err}|${restriction}`;
  return crypto.createHash('md5').update(payload).digest('hex').slice(0, 16);
}

class CircularLogBuffer {
  constructor(capacity = 100) {
    this.capacity = Math.max(1, Number(capacity) || 100);
    this.buffer = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
    this.logSeq = 0;
  }

  push(item) {
    this.logSeq++;
    const entry = typeof item === 'object' && item !== null
      ? { seq: this.logSeq, ...item, loggedAt: item.loggedAt || new Date().toISOString() }
      : { seq: this.logSeq, message: String(item), loggedAt: new Date().toISOString() };

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
