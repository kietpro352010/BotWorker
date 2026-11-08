'use strict';

const express = require('express');
const helmet = require('helmet');
const { createRouter } = require('./routes');

function createApp(dependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use(createRouter(dependencies));
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'not_found' }));
  app.use((error, _req, res, _next) => {
    dependencies.logger.error('http_request_failed', { name: error.name || 'Error' });
    res.status(500).json({ ok: false, error: 'internal_error' });
  });
  return app;
}

module.exports = { createApp };

