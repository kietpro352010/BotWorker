'use strict';

const DEFAULT_PANEL_URL = 'https://wispbyte.com/client';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function isAllowedPanelUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return host === 'wispbyte.com' || host.endsWith('.wispbyte.com');
  } catch {
    return false;
  }
}

class WispbyteKeepAlive {
  constructor(config = {}, logger = console, { fetchImpl = global.fetch } = {}) {
    this.cookie = String(config.cookie || '').trim();
    this.panelUrl = String(config.panelUrl || DEFAULT_PANEL_URL).trim();
    this.userAgent = String(config.userAgent || DEFAULT_USER_AGENT).trim();
    this.intervalMs = Math.max(60000, Math.min(604800000, Number(config.intervalMs) || TWENTY_FOUR_HOURS_MS));
    this.logger = logger;
    this.fetch = fetchImpl;
    this.enabled = Boolean(this.cookie);
    this.timer = null;
    this.initialTimer = null;
    this.lastPingAt = null;
    this.lastStatus = 'idle';
    this.lastMessage = this.enabled ? 'Configured, waiting for initial ping' : 'Disabled (no cookie configured)';
    this.renewCount = 0;

    if (this.enabled && !isAllowedPanelUrl(this.panelUrl)) {
      this.enabled = false;
      this.lastStatus = 'error';
      this.lastMessage = 'Insecure or unwhitelisted panel URL. HTTPS and wispbyte.com domain required.';
      this.logger.warn?.('wispbyte_keepalive_insecure_url', { url: this.panelUrl });
    }
  }

  async ping() {
    if (!this.enabled || !this.cookie) {
      return {
        success: false,
        status: this.lastStatus === 'error' ? 'error' : 'disabled',
        message: this.lastMessage || 'WISPBYTE_COOKIE is not configured.'
      };
    }
    if (!isAllowedPanelUrl(this.panelUrl)) {
      return { success: false, status: 'error', message: 'Insecure or unwhitelisted panel URL.' };
    }

    try {
      this.logger.info?.('wispbyte_keepalive_ping_start', { url: this.panelUrl });
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(new Error('Keepalive request timed out after 15000ms.')), 15000);
      timeoutTimer.unref?.();
      let res;
      try {
        res = await this.fetch(this.panelUrl, {
          method: 'GET',
          headers: {
            'Cookie': this.cookie,
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache'
          },
          redirect: 'manual',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutTimer);
      }

      const location = res.headers.get('location') || '';
      const html = await res.text().catch(() => '');
      this.lastPingAt = new Date().toISOString();

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const lowerLoc = location.toLowerCase();
        if (lowerLoc.includes('login') || lowerLoc.includes('auth') || lowerLoc.includes('discord')) {
          this.lastStatus = 'expired';
          this.lastMessage = `Session cookie expired (redirected to ${location})`;
          this.logger.warn?.('wispbyte_keepalive_cookie_expired', { location });
          return { success: false, status: this.lastStatus, message: this.lastMessage };
        }
        this.lastStatus = 'ok';
        this.lastMessage = `HTTP ${res.status} -> ${location}`;
        this.renewCount += 1;
        this.logger.info?.('wispbyte_keepalive_success', { status: res.status, renewCount: this.renewCount });
        return { success: true, status: this.lastStatus, message: this.lastMessage };
      }

      if (res.status === 200) {
        const lower = html.toLowerCase();
        if ((lower.includes('login with discord') || lower.includes('sign in to your account'))
            && !lower.includes('logout') && !lower.includes('servers')) {
          this.lastStatus = 'expired';
          this.lastMessage = 'Client panel requested re-login (Cookie expired)';
          this.logger.warn?.('wispbyte_keepalive_cookie_expired', { status: 200 });
          return { success: false, status: this.lastStatus, message: this.lastMessage };
        }
        this.lastStatus = 'ok';
        this.lastMessage = 'Client panel accessed successfully (HTTP 200)';
        this.renewCount += 1;
        this.logger.info?.('wispbyte_keepalive_success', { renewCount: this.renewCount });
        return { success: true, status: this.lastStatus, message: this.lastMessage };
      }

      if (res.status === 401 || res.status === 403) {
        this.lastStatus = 'error';
        this.lastMessage = `HTTP ${res.status} (Cloudflare challenge or forbidden)`;
        this.logger.warn?.('wispbyte_keepalive_blocked', { status: res.status });
        return { success: false, status: this.lastStatus, message: this.lastMessage };
      }

      this.lastStatus = 'error';
      this.lastMessage = `HTTP ${res.status}`;
      return { success: false, status: this.lastStatus, message: this.lastMessage };
    } catch (err) {
      this.lastPingAt = new Date().toISOString();
      this.lastStatus = 'error';
      this.lastMessage = `Connection error: ${err.message}`;
      this.logger.warn?.('wispbyte_keepalive_error', { error: err.message });
      return { success: false, status: this.lastStatus, message: this.lastMessage };
    }
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.logger.info?.('wispbyte_keepalive_started', {
      panelUrl: this.panelUrl,
      intervalHours: Math.round(this.intervalMs / 3600000)
    });

    // Run first ping after 30 seconds
    this.initialTimer = setTimeout(() => {
      void this.ping().catch(() => {});
    }, 30000);
    this.initialTimer.unref?.();

    // Schedule regular ping every intervalMs (e.g. 24 hours)
    this.timer = setInterval(() => {
      void this.ping().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      panelUrl: this.panelUrl,
      lastPingAt: this.lastPingAt,
      lastStatus: this.lastStatus,
      lastMessage: this.lastMessage,
      renewCount: this.renewCount
    };
  }
}

module.exports = WispbyteKeepAlive;
