'use strict';

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const MAINTENANCE_START_MINUTE = 4 * 60 + 30;
const MAINTENANCE_END_MINUTE = 5 * 60 + 30;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function localParts(value = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

function isMaintenanceWindow(value = new Date()) {
  const { hour, minute } = localParts(value);
  const localMinute = hour * 60 + minute;
  return localMinute >= MAINTENANCE_START_MINUTE && localMinute < MAINTENANCE_END_MINUTE;
}

function nextMaintenanceBoundary(value = new Date()) {
  const parts = localParts(value);
  const localMinute = parts.hour * 60 + parts.minute;
  let boundaryMinute;
  let dayOffset = 0;
  if (localMinute < MAINTENANCE_START_MINUTE) boundaryMinute = MAINTENANCE_START_MINUTE;
  else if (localMinute < MAINTENANCE_END_MINUTE) boundaryMinute = MAINTENANCE_END_MINUTE;
  else { boundaryMinute = MAINTENANCE_START_MINUTE; dayOffset = 1; }

  const localDay = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset);
  const boundaryHour = Math.floor(boundaryMinute / 60);
  const boundaryMinutePart = boundaryMinute % 60;
  return new Date(localDay + boundaryHour * 60 * 60 * 1000 + boundaryMinutePart * 60 * 1000 - BANGKOK_OFFSET_MS);
}

class StaggeredReconnectQueue {
  constructor({ baseSpacingMs = 4000, maxSpacingMs = 8000 } = {}) {
    this.baseSpacingMs = baseSpacingMs;
    this.maxSpacingMs = maxSpacingMs;
    this.lastScheduledAt = 0;
  }

  nextDelay() {
    const now = Date.now();
    const spacing = this.baseSpacingMs + Math.floor(Math.random() * 1000);
    const earliest = Math.max(now, this.lastScheduledAt + spacing);
    this.lastScheduledAt = earliest;
    return Math.max(0, earliest - now);
  }

  reset() {
    this.lastScheduledAt = 0;
  }
}

const defaultReconnectQueue = new StaggeredReconnectQueue();

function getStaggeredReconnectDelay(index = 0, spacingMs = 4000) {
  const base = Math.max(0, index) * spacingMs;
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}

module.exports = {
  TIME_ZONE,
  MAINTENANCE_START_MINUTE,
  MAINTENANCE_END_MINUTE,
  isMaintenanceWindow,
  nextMaintenanceBoundary,
  StaggeredReconnectQueue,
  defaultReconnectQueue,
  getStaggeredReconnectDelay
};
