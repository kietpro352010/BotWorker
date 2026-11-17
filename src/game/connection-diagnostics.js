'use strict';

const dns = require('node:dns');

function logMinecraftHostResolution(host, port, logger) {
  try {
    dns.lookup(host, { all: true }, (error, addresses) => {
      if (error) {
        logger.warn('minecraft_dns_lookup_failed', {
          host, port, code: String(error.code || 'dns_lookup_failed').slice(0, 48),
          error: String(error.message || error).slice(0, 180)
        });
        return;
      }
      logger.info('minecraft_dns_resolved', {
        host, port,
        addresses: addresses.map(({ address, family }) => ({ address, family }))
      });
    });
  } catch (error) {
    logger.warn('minecraft_dns_lookup_failed', {
      host, port, code: String(error.code || 'dns_lookup_failed').slice(0, 48),
      error: String(error.message || error).slice(0, 180)
    });
  }
}

function attachMinecraftConnectionDiagnostics(bot, { host, port, logger } = {}) {
  const client = bot?._client;
  if (client) {
    client.on('connect', () => logger.info('minecraft_tcp_connected', { host, port }));
    client.on('close', (hadError) => logger.info('minecraft_tcp_socket_closed', { host, port, hadError: Boolean(hadError) }));
  }
  bot?.once?.('login', () => logger.info('minecraft_login_packet_received', { host }));
}

module.exports = { logMinecraftHostResolution, attachMinecraftConnectionDiagnostics };
