'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REQUIRED_RUNTIME_PACKAGES = [
  'express',
  'helmet',
  'dotenv',
  'socks',
  'mineflayer',
  'minecraft-data'
];

function findMissingPackages(rootDir, requiredPackages = REQUIRED_RUNTIME_PACKAGES) {
  const missing = [];
  if (
    requiredPackages === REQUIRED_RUNTIME_PACKAGES &&
    fs.existsSync(path.join(rootDir, 'package-lock.json')) &&
    !fs.existsSync(path.join(rootDir, 'node_modules', '.package-lock.json'))
  ) {
    missing.push('.package-lock.json');
  }
  for (const pkg of requiredPackages) {
    const pkgJson = path.join(rootDir, 'node_modules', pkg, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      missing.push(pkg);
      continue;
    }
    try {
      require.resolve(pkg, { paths: [rootDir] });
    } catch (_) {
      missing.push(pkg);
    }
  }
  return missing;
}

function resolveNpmCommand(execPath = process.execPath, platform = process.platform) {
  const nodeDir = path.dirname(execPath);
  const npmCliCandidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js'
  ];
  for (const candidate of npmCliCandidates) {
    if (fs.existsSync(candidate)) {
      return { command: execPath, prefixArgs: [candidate] };
    }
  }
  if (platform !== 'win32' && fs.existsSync('/usr/local/bin/npm')) {
    return { command: '/usr/local/bin/npm', prefixArgs: [] };
  }
  return { command: platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [] };
}

function buildLowMemoryInstallEnv(baseEnv = process.env) {
  const cleanedNodeOptions = String(baseEnv.NODE_OPTIONS || '')
    .replace(/--max-old-space-size=\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const nodeOptions = cleanedNodeOptions
    ? `${cleanedNodeOptions} --max-old-space-size=400`
    : '--max-old-space-size=400';

  return {
    ...baseEnv,
    KBOT_AUTO_INSTALL_ATTEMPTED: '1',
    NODE_OPTIONS: nodeOptions,
    UV_THREADPOOL_SIZE: '1',
    npm_config_maxsockets: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_progress: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
    npm_config_omit: 'dev'
  };
}

function ensureRuntimeDependencies({
  rootDir = path.resolve(__dirname, '..'),
  requiredPackages = REQUIRED_RUNTIME_PACKAGES,
  env = process.env,
  spawnSyncImpl = cp.spawnSync,
  log = console
} = {}) {
  const missing = findMissingPackages(rootDir, requiredPackages);
  if (missing.length === 0) {
    return { ok: true, healed: false, missing: [] };
  }

  if (env.KBOT_SKIP_AUTO_INSTALL === '1' || env.KBOT_AUTO_INSTALL_ATTEMPTED === '1') {
    return { ok: false, healed: false, missing };
  }

  log.warn?.(JSON.stringify({
    level: 'warn',
    time: new Date().toISOString(),
    message: 'worker_missing_dependencies_healing',
    missing
  }));

  const installEnv = buildLowMemoryInstallEnv(env);
  const { command, prefixArgs } = resolveNpmCommand();
  const hasLockfile = fs.existsSync(path.join(rootDir, 'package-lock.json'));
  const commonFlags = ['--omit=dev', '--omit=optional', '--no-audit', '--no-fund'];

  let res = null;
  if (hasLockfile) {
    res = spawnSyncImpl(command, [...prefixArgs, 'ci', ...commonFlags], {
      cwd: rootDir,
      env: installEnv,
      stdio: 'inherit',
      shell: command.endsWith('.cmd')
    });
  }
  if (!res || res.status !== 0) {
    res = spawnSyncImpl(command, [...prefixArgs, 'install', ...commonFlags], {
      cwd: rootDir,
      env: installEnv,
      stdio: 'inherit',
      shell: command.endsWith('.cmd')
    });
  }

  try {
    const homeDir = env.HOME || '/home/container';
    const cacheDir = path.join(homeDir, '.npm', '_cacache');
    if (homeDir === '/home/container' && fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  } catch (_) {}

  const stillMissing = findMissingPackages(rootDir, requiredPackages);
  const ok = stillMissing.length === 0 && res?.status === 0;
  if (ok) {
    log.info?.(JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      message: 'worker_dependencies_healed'
    }));
  } else {
    log.error?.(JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      message: 'worker_dependencies_heal_failed',
      exitCode: res?.status ?? null,
      stillMissing
    }));
  }
  return { ok, healed: ok, missing: stillMissing };
}

module.exports = {
  REQUIRED_RUNTIME_PACKAGES,
  findMissingPackages,
  resolveNpmCommand,
  buildLowMemoryInstallEnv,
  ensureRuntimeDependencies
};
