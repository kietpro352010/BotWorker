'use strict';

/**
 * Root entrypoint for Render, Wispbyte, PaaS hosts, and CLI execution.
 * Automatically heals missing node_modules in low-memory mode if a container's
 * startup `npm install` was killed by cgroup OOM limits, then boots src/index.js.
 */
const path = require('node:path');
const { ensureRuntimeDependencies } = require('./src/bootstrap-deps');

ensureRuntimeDependencies({ rootDir: __dirname });
require(path.join(__dirname, 'src', 'index.js'));
