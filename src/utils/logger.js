'use strict';

const SECRET_KEYS = /password|secret|token|cookie|authorization/i;

function redact(value, key = '') {
  if (SECRET_KEYS.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

function write(level, message, fields = {}) {
  const record = { time: new Date().toISOString(), level, message: String(message), ...redact(fields) };
  const line = JSON.stringify(record);
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

module.exports = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
  debug: (message, fields) => { if (process.env.LOG_LEVEL === 'debug') write('debug', message, fields); }
};

