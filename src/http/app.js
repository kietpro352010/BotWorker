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
    dependencies.logger?.error?.('http_request_failed', { name: error.name || 'Error', message: error.message });
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
    if (status === 400 || error.type === 'entity.parse.failed' || (error instanceof SyntaxError && 'body' in error)) {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    if (status === 413 || error.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'payload_too_large' });
    }
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      error: status === 404 ? 'not_found' : 'internal_error'
    });
  });
  return app;
}

module.exports = { createApp };

