'use strict';

const SECRET_KEYS = /password|secret|token|cookie|authorization|apikey|api_key|credential|proxyurl|proxy_url/i;

function redactStringUrls(str) {
  if (typeof str !== 'string') return str;
  if (!str.includes('://') || !str.includes('@')) return str;
  return str.replace(/(:\/\/[^\s:@]+:)[^\s@]+(@)/g, '$1***$2');
}

function redact(value, key = '', visited = new WeakSet(), depth = 0) {
  if (SECRET_KEYS.test(key)) return '[REDACTED]';
  if (depth > 8) return '[MAX_DEPTH]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactStringUrls(value.message),
      stack: redactStringUrls(value.stack),
      code: value.code
    };
  }
  if (Array.isArray(value)) {
    if (visited.has(value)) return '[CIRCULAR]';
    visited.add(value);
    try {
      return value.map((item) => redact(item, key, visited, depth + 1));
    } finally {
      visited.delete(value);
    }
  }
  if (value && typeof value === 'object') {
    if (visited.has(value)) return '[CIRCULAR]';
    visited.add(value);
    try {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, visited, depth + 1)]));
    } finally {
      visited.delete(value);
    }
  }
  if (typeof value === 'string') {
    return redactStringUrls(value);
  }
  return value;
}

function write(level, message, fields = {}) {
  const safeFields = typeof fields === 'object' && fields !== null && !Array.isArray(fields) ? redact(fields) : { data: redact(fields) };
  const record = {
    ...safeFields,
    time: new Date().toISOString(),
    level,
    message: String(message)
  };

  let line;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    line = JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      message: 'logger_serialization_failed',
      error: String(err?.message || err)
    });
  }
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

module.exports = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
  debug: (message, fields) => { if (process.env.LOG_LEVEL === 'debug') write('debug', message, fields); }
};

