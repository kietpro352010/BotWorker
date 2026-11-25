#!/bin/sh
# Wispbyte pre-deploy hook (executed via: sh .wispbyte/deploy.sh)
# Prevents Linux cgroup OOM kills during fresh `npm install` on 256MB-512MB containers.

if [ -f "/home/container/package.json" ]; then
  cd /home/container || exit 0
fi

if [ "${AUTO_UPDATE:-0}" = "1" ] && [ -d ".git" ]; then
  git pull --ff-only 2>/dev/null || true
fi

NPM_BIN="/usr/local/bin/npm"
if [ ! -x "$NPM_BIN" ]; then
  NPM_BIN="npm"
fi

export NODE_OPTIONS="--max-old-space-size=112"
export UV_THREADPOOL_SIZE="1"
export npm_config_maxsockets="1"
export npm_config_audit="false"
export npm_config_fund="false"
export npm_config_progress="false"
export npm_config_update_notifier="false"
export npm_config_loglevel="error"
export npm_config_omit="dev"

NEED_INSTALL="0"
if [ -f "package-lock.json" ] && [ ! -f "node_modules/.package-lock.json" ]; then
  NEED_INSTALL="1"
fi

if [ "$NEED_INSTALL" = "0" ]; then
  for mod in express helmet dotenv socks mineflayer minecraft-data; do
    if [ ! -f "node_modules/$mod/package.json" ]; then
      NEED_INSTALL="1"
      break
    fi
  done
fi

if [ "$NEED_INSTALL" = "1" ]; then
  echo "[wispbyte-deploy] Installing worker dependencies in low-memory mode (max-old-space-size=112, maxsockets=1)..."
  rm -rf node_modules/.staging 2>/dev/null || true
  if [ -f "package-lock.json" ]; then
    "$NPM_BIN" ci --omit=dev --omit=optional --no-audit --no-fund || "$NPM_BIN" install --omit=dev --omit=optional --no-audit --no-fund
  else
    "$NPM_BIN" install --omit=dev --omit=optional --no-audit --no-fund
  fi
  rm -rf "${HOME:-/home/container}/.npm/_cacache" /tmp/npm-* 2>/dev/null || true
fi

exit 0
