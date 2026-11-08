'use strict';

const STATES = Object.freeze(['stopped', 'connecting', 'authenticating', 'entering', 'online', 'maintenance', 'ip_limited', 'banned', 'error']);

function normalizeState(state) {
  return STATES.includes(state) ? state : 'error';
}

module.exports = { STATES, normalizeState };

