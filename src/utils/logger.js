'use strict';

const SECRET_KEYS = /password|secret|token|cookie|authorization|apikey|api_key|credential|proxyurl|proxy_url/i;

const PRIVATE_KEY_PEM_REGEX = /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----[\s\S]*?(?:-----END[ A-Z0-9_-]*PRIVATE KEY-----|$)/gi;
const URL_CREDENTIAL_REGEX = /([a-zA-Z0-9+.-]+:\/\/[^\s:@]+:)[^\s@]+(@)/g;
const TELEGRAM_BOT_URL_REGEX = /(\/bot\d{5,15}:)[A-Za-z0-9_-]+(\/?)/gi;
const DISCORD_WEBHOOK_URL_REGEX = /(\/(?:api(?:\/v\d+)?\/)?webhooks\/\d+\/)[A-Za-z0-9_.-]+/gi;
const JSON_SECRET_REGEX = /("(?:password|passwd|pass|token|access_?token|refresh_?token|secret|cookie|api_?key|authorization|session|credential|proxy_?url)"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi;
const COOKIE_HEADER_REGEX = /(\b(?:set-)?cookie\s*:\s*)(?!\[REDACTED\])([^\r\n"]+)/gi;
const AUTH_HEADER_REGEX = /(\bauthorization\s*[:=]\s*)(?:(?:Bearer|Basic|Token)\s+)?(?!\[REDACTED\])[^\s\r\n,;"]+/gi;
const BEARER_TOKEN_REGEX = /(\bBearer\s+)(?!\[REDACTED\])[A-Za-z0-9_.\-+/=]{6,}/gi;
const JWT_TOKEN_REGEX = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const QUERY_SECRET_REGEX = /([?&](?:api(?:_?key)?|token|access_?token|refresh_?token|key|secret|password|passwd|auth|signature|sig)\s*=\s*)(?!\[REDACTED\])([^&\s\r\n"'#]+)/gi;
const KV_SECRET_REGEX = /(\b(?:token|secret|password|passwd|api_?key|access_?token|refresh_?token|authorization|cookie|session|key)\s*[:=]\s*)(?!\[REDACTED\])([^\s&"';,\r\n]+)/gi;
const MC_AUTH_CMD_REGEX = /(\/(?:[a-z0-9_-]+:)?(?:login|l|dn|register|reg|dk|changepassword|changepass|password|unregister|email)\s+)([^\r\n"`]+)/gim;

function redactStringSecrets(str) {
  if (typeof str !== 'string' || !str) return str;
  return str
    .replace(PRIVATE_KEY_PEM_REGEX, '[REDACTED PRIVATE KEY]')
    .replace(URL_CREDENTIAL_REGEX, '$1***$2')
    .replace(TELEGRAM_BOT_URL_REGEX, '$1[REDACTED]$2')
    .replace(DISCORD_WEBHOOK_URL_REGEX, '$1[REDACTED]')
    .replace(JSON_SECRET_REGEX, '$1[REDACTED]$3')
    .replace(COOKIE_HEADER_REGEX, '$1[REDACTED]')
    .replace(AUTH_HEADER_REGEX, '$1[REDACTED]')
    .replace(BEARER_TOKEN_REGEX, '$1[REDACTED]')
    .replace(JWT_TOKEN_REGEX, '[REDACTED_JWT]')
    .replace(QUERY_SECRET_REGEX, '$1[REDACTED]')
    .replace(KV_SECRET_REGEX, '$1[REDACTED]')
    .replace(MC_AUTH_CMD_REGEX, '$1[REDACTED]');
}

function redact(value, key = '', visited = new WeakSet(), depth = 0) {
  if (SECRET_KEYS.test(key)) return '[REDACTED]';
  if (typeof value === 'bigint') return value.toString();
  if (depth > 8) return '[MAX_DEPTH]';
  if (value instanceof Error) {
    if (visited.has(value)) return '[CIRCULAR]';
    visited.add(value);
    try {
      return {
        name: value.name,
        message: redactStringSecrets(value.message),
        stack: redactStringSecrets(value.stack),
        code: value.code
      };
    } finally {
      visited.delete(value);
    }
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
    return redactStringSecrets(value);
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
      error: redactStringSecrets(String(err?.message || err))
    });
  }
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

module.exports = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
  debug: (message, fields) => { if (process.env.LOG_LEVEL === 'debug') write('debug', message, fields); },
  redact,
  redactStringSecrets
};

