const mineflayer = require('mineflayer');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns');
const v8 = require('v8');
const vm = require('vm');

// 🚀 Dynamic V8 GC runtime injection: Cho phép giải phóng RAM thực sự ngay cả khi không truyền cờ --expose-gc
let dynamicGc = null;
try {
    v8.setFlagsFromString('--expose_gc');
    dynamicGc = vm.runInNewContext('gc');
} catch (_) {}

function runGarbageCollection() {
    try {
        if (typeof global.gc === 'function') {
            global.gc();
            return true;
        } else if (typeof dynamicGc === 'function') {
            dynamicGc();
            return true;
        }
    } catch (_) {}
    return false;
}

// ============================================================================
// CẤU HÌNH TỔNG BOT MINECRAFT KINGMC (COMMERCIAL ENTERPRISE EDITION V11.6)
//
// Triển khai file này lên Render Web Service hoặc VPS dưới dạng index.js / bot.js.
// Tự động nhận diện Render Cloud Native (PORT 10000) và khởi chạy Web UI tức thì!
// Chỉnh sửa các trường cấu hình trực tiếp ngay bên dưới:
// ============================================================================
const BOT_CONFIG = {
    // --- 0. KHÓA BẢO MẬT NỘI BỘ MANAGER <-> BOT CON ---
    BOT_SECRET_KEY: '',                   // Khóa bí mật giao tiếp dịch vụ nội bộ
    MANAGER_API_URL: '',                  // URL của Web Manager (VD: 'https://kbot-manager.onrender.com' hoặc 'http://localhost:3000')

    // --- 1. TÀI KHOẢN BOT (ĐỂ TRỐNG ĐỂ TỰ ĐIỀN HOẶC NHẬP TỪ WEB UI) ---
    USERNAME: '',                         // Tên tài khoản Minecraft ingame (VD: 'AFK_PRO_01')
    PASSWORD: '',                         // Mật khẩu /login trong server KingMC (VD: 'matkhau123')

    // --- 2. SERVER MINECRAFT KINGMC ---
    MC_HOSTS: ['sgp.kingmc.vn', 'kingmc.vn', 'java.kingmc.vn'], // Danh sách IP server KingMC xoay vòng tuần tự (5 lần/IP)
    MC_PORT: 25565,                           // Cổng Minecraft mặc định (25565)
    MC_VERSION: '1.20.1',                     // Phiên bản Minecraft kết nối

    // --- 3. THÔNG BÁO WEBHOOK DISCORD & TELEGRAM (ĐỂ TRỐNG NẾU CHƯA DÙNG) ---
    DISCORD_WEBHOOK_URL: '',              // Link Discord Webhook nhận thông báo kick, chết, spawn
    TELEGRAM_BOT_TOKEN: '',               // Token Bot Telegram (VD: '123456789:ABCdefGhI...')
    TELEGRAM_CHAT_ID: '',                 // ID cuộc trò chuyện Telegram nhận thông báo

    // --- 4. CỔNG MÁY CHỦ WEB & NỀN TẢNG HOSTING (THUẦN RENDER CLOUD) ---
    PLATFORM: 'auto',                     // 'auto' (Tự nhận diện Render Cloud Web Service / Local PC)
    WEB_PORT: 10000,                      // Cổng Web mặc định trên Render (Render tự gán PORT=10000; test Local dự phòng 3000)
    BOT_ID: process.env.BOT_ID || '1',    // ID định danh của bot (ưu tiên biến môi trường khi deploy)

    // --- 5. TỐI ƯU HÓA BỘ NHỚ & CHỐNG TRÀN RAM (WATCHDOG 300-500MB) ---
    AUTO_START: true,                     // Tự động kết nối vào game nếu đã có USERNAME và PASSWORD
    VIEW_DISTANCE: 'tiny',                // Tầm nhìn tối thiểu để tiết kiệm RAM tối đa
    CHECK_TIMEOUT_MS: 30000,              // Timeout kiểm tra kết nối mạng
    RAM_WATCHDOG_LIMIT_MB: 380,           // Ngưỡng RAM tự dọn dẹp sạch sẽ và kích hoạt GC (300-500MB)

    // --- 6. TỌA ĐỘ CHUYỂN SERVER KINGMC ---
    AUTH_COORDS: { x: 5, y: 119, z: 4 },
    LOBBY_COORDS: { x: 1, y: 41, z: 1 },

    // --- 7. TỐI ƯU HÓA KHU FARM HẠT & ITEM (KELP / MOB FARM) ---
    FARM_OPTIMIZATION: {
        ENABLED: true,
        MAX_ENTITIES_IN_MEMORY: 120,      // Giới hạn thực thể lưu trong RAM (chống tràn 512MB RAM Render)
        IGNORE_ITEM_PHYSICS: true,        // Bỏ qua tính toán va chạm với item rơi
        DROP_PARTICLES_AND_SOUNDS: true,  // Chặn hoàn toàn packet hạt bọt nước & âm thanh farm
        CHUNK_CULL_RADIUS: 2,             // Chỉ giữ 2 chunks quanh bot, giải phóng map thừa
        PRUNE_INTERVAL_MS: 20000          // Quét dọn chunk map ở xa mỗi 20 giây (chống nghẽn CPU)
    },

    // --- 8. CẤU HÌNH HÀNH VI TỰ ĐỘNG (THUẦN AFK & ANTI-AFK) ---
    DEFAULT_SETTINGS: {
        autoTotem: true,                  // Tự cầm totem khi còn ít máu phòng té ngã
        antiHungry: true,                 // Tự ăn khi đói chống chết đói khi treo máy
        autoReconnect: true,              // Tự kết nối lại khi mất mạng / server restart
        antiAfkKick: true,                // Giả lập vi chuyển động yaw/pitch & sneak chống kick AFK
        ecoMode: true,                    // 🌱 Chế độ Siêu Tiết Kiệm Eco: giảm physics loop, hạ CPU ~0%, giữ RAM 150-220MB
        spawnCommands: '',                // ⚡ Chuỗi lệnh tự động chạy tuần tự khi vào trạng thái AFK (cách nhau 1.6s)
        proxy: {
            enabled: false,
            protocol: 'socks5',
            host: '',
            port: 0,
            username: '',
            password: ''
        }
    }
};

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}
if (process.env.RENDER && !process.env.DATA_DIR) {
    console.warn('[SECURITY WARNING] Phát hiện môi trường Render nhưng biến DATA_DIR chưa được cấu hình. Dữ liệu có thể bị mất khi instance khởi động lại hoặc redeploy. Khuyến nghị gắn Render Persistent Disk.');
}
if (DATA_DIR !== __dirname) {
    for (const filename of ['bot_settings.json', 'bot_auth_cache.json', '.bot_master_key', '.bot_secret_key', '.supabase_secret']) {
        const oldPath = path.join(__dirname, filename);
        const newPath = path.join(DATA_DIR, filename);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
            try {
                fs.copyFileSync(oldPath, newPath);
                console.log(`[MIGRATION] Đã di chuyển ${filename} từ ${oldPath} sang ${newPath}`);
            } catch (e) {
                console.error(`[MIGRATION] Lỗi di chuyển ${filename}:`, e.message);
            }
        }
    }
}

let botSecretKeySource = String(process.env.BOT_SECRET_KEY || BOT_CONFIG.BOT_SECRET_KEY || '').trim();
const botSecretKeyFile = path.join(DATA_DIR, '.bot_secret_key');
if (!botSecretKeySource) {
    try {
        if (fs.existsSync(botSecretKeyFile)) {
            botSecretKeySource = fs.readFileSync(botSecretKeyFile, 'utf8').trim();
        }
    } catch (_) {}
}
const BOT_SECRET_KEY = botSecretKeySource;
if (!BOT_SECRET_KEY) {
    console.log('[SECURITY] ℹ️ BOT_SECRET_KEY chưa được cấu hình. Chế độ Cloud Plug-and-Play kích hoạt (Cho phép kết nối từ Manager).');
}
const BOT_ADMIN_PASSWORD = String(process.env.BOT_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '').trim();
const MANAGER_API_URL = String(process.env.MANAGER_API_URL || BOT_CONFIG.MANAGER_API_URL || '').trim().replace(/\/+$/, '');


// ----------------------------------------------------------------------------
// SUPABASE CLOUD DATABASE ADAPTER (BOT WORKER ENGINE)
// ----------------------------------------------------------------------------
class BotSupabaseAdapter {
    constructor(config = {}) {
        this.url = (config.url || process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
        this.key = (config.key || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
        this.botId = String(config.botId || process.env.BOT_ID || '1');
        this.enabled = !!(this.url && this.key);
    }

    isEnabled() {
        return !!(this.url && this.key);
    }

    getHeaders(extra = {}) {
        return {
            'apikey': this.key,
            'Authorization': `Bearer ${this.key}`,
            'Content-Type': 'application/json',
            ...extra
        };
    }

    async fetchBotSettings() {
        if (!this.isEnabled()) return null;
        try {
            const res = await fetch(`${this.url}/rest/v1/bot_settings?bot_id=eq.${encodeURIComponent(this.botId)}&select=*`, {
                headers: this.getHeaders(),
                signal: AbortSignal.timeout(6000)
            });
            if (!res.ok) return null;
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                return data[0];
            }
            return null;
        } catch (err) {
            console.error('[BOT SUPABASE] Lỗi đọc bot_settings:', err.message);
            return null;
        }
    }

    async saveBotSettings(payload) {
        if (!this.isEnabled()) return false;
        try {
            const persistedSettings = {
                ...(payload.settings && typeof payload.settings === 'object' ? payload.settings : {}),
                manuallyStopped: payload.manuallyStopped === true
            };
            const row = {
                bot_id: this.botId,
                username: payload.username || '',
                password: payload.password || '',
                settings: persistedSettings,
                proxy: payload.proxy || payload.settings?.proxy || {},
                schedules: payload.botSchedules || payload.schedules || [],
                auto_chat: payload.autoChatSchedules || payload.auto_chat || [],
                updated_at: new Date().toISOString()
            };
            const res = await fetch(`${this.url}/rest/v1/bot_settings`, {
                method: 'POST',
                headers: this.getHeaders({ 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
                body: JSON.stringify([row]),
                signal: AbortSignal.timeout(8000)
            });
            return res.ok;
        } catch (err) {
            console.error('[BOT SUPABASE] Lỗi lưu bot_settings:', err.message);
            return false;
        }
    }

    async logBotAction({ action, actionLabel, category = 'BOT_SETTINGS', details, status = 'SUCCESS' }) {
        if (!this.isEnabled()) return false;
        try {
            const row = {
                id: 'aud_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
                log_type: 'BOT',
                category: category,
                action: action,
                action_label: actionLabel || action,
                actor_username: 'bot_worker_' + this.botId,
                actor_role: 'bot',
                actor_ip: '127.0.0.1',
                target: { botId: this.botId },
                details: details || '',
                status: status,
                timestamp: new Date().toISOString()
            };
            const res = await fetch(`${this.url}/rest/v1/audit_logs`, {
                method: 'POST',
                headers: this.getHeaders({ 'Prefer': 'return=minimal' }),
                body: JSON.stringify([row]),
                signal: AbortSignal.timeout(4000)
            });
            return res.ok;
        } catch (_) {
            return false;
        }
    }
}

const botSupabase = new BotSupabaseAdapter({
    url: process.env.SUPABASE_URL || '',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '',
    botId: process.env.BOT_ID || BOT_CONFIG.BOT_ID || '1'
});

function isManagerSecretRequest(req) {
    if (!BOT_SECRET_KEY) {
        return true;
    }
    const incoming = String(req.headers['x-bot-secret'] || '').trim();
    return !!incoming && timingSafeStringEquals(incoming, BOT_SECRET_KEY);
}

function isTrustedManagerRequest(req) {
    return isManagerSecretRequest(req);
}

class MemoryRateLimiter {
    constructor({ maxFailures = 5, windowMs = 15 * 60 * 1000, maxEntries = 5000, message = 'Quá nhiều lần thử thất bại. Vui lòng thử lại sau.' } = {}) {
        this.maxFailures = maxFailures;
        this.windowMs = windowMs;
        this.maxEntries = maxEntries;
        this.message = message;
        this.attempts = new Map();
    }

    _clean() {
        const now = Date.now();
        if (this.attempts.size > this.maxEntries) {
            for (const [key, val] of this.attempts.entries()) {
                if (now - val.lastAttempt > this.windowMs && (!val.lockedUntil || now > val.lockedUntil)) {
                    this.attempts.delete(key);
                }
            }
            if (this.attempts.size > this.maxEntries) {
                for (const [key, val] of this.attempts.entries()) {
                    if (this.attempts.size <= this.maxEntries) break;
                    if (!val.lockedUntil || now >= val.lockedUntil) {
                        this.attempts.delete(key);
                    }
                }
            }
        }
    }

    _getKeys(ip, identifier = '') {
        const normIp = String(ip || 'unknown').trim().toLowerCase() || 'unknown';
        const normId = String(identifier || '').trim().toLowerCase();
        const keys = [`ip:${normIp}`];
        if (normId) keys.push(`id:${normId}`);
        return keys;
    }

    check(ip, identifier = '') {
        this._clean();
        const now = Date.now();
        let lockedUntil = 0;
        for (const key of this._getKeys(ip, identifier)) {
            const record = this.attempts.get(key);
            if (record?.lockedUntil && now < record.lockedUntil) {
                lockedUntil = Math.max(lockedUntil, record.lockedUntil);
            }
        }
        if (lockedUntil) {
            const remainingSec = Math.ceil((lockedUntil - now) / 1000);
            const remainingMin = Math.ceil(remainingSec / 60);
            return {
                allowed: false,
                error: `${this.message} (Chờ ${remainingMin} phút / ${remainingSec}s)`
            };
        }
        return { allowed: true };
    }

    record(ip, identifier = '', success = false) {
        this._clean();
        const now = Date.now();
        for (const key of this._getKeys(ip, identifier)) {
            if (success) {
                this.attempts.delete(key);
                continue;
            }
            const record = this.attempts.get(key) || { count: 0, lockedUntil: 0, lastAttempt: now };
            record.count += 1;
            record.lastAttempt = now;
            if (record.count >= this.maxFailures) {
                record.lockedUntil = now + this.windowMs;
            }
            this.attempts.set(key, record);
        }
    }
}

const botLoginLimiter = new MemoryRateLimiter({
    maxFailures: 5,
    windowMs: 15 * 60 * 1000,
    message: 'Cổng đăng nhập tạm khóa do nhập sai mật khẩu quá nhiều lần.'
});

function getClientIp(req) {
    return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

const botSessions = new Map();

function createBotSession(role, username, options = {}) {
    const token = 'bsess_' + crypto.randomBytes(32).toString('hex');
    botSessions.set(token, {
        role,
        username,
        passwordHash: options.passwordHash || '',
        allowAccountChange: role === 'admin' || options.allowAccountChange === true,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000
    });
    return token;
}

function verifyBotSession(token) {
    if (!token) return null;
    const sess = botSessions.get(token);
    if (!sess) return null;
    if (Date.now() > sess.expiresAt) {
        botSessions.delete(token);
        return null;
    }
    if (typeof botState !== 'undefined' && botState && botState.syncedAuth) {
        if (sess.role === 'admin') {
            if (botState.syncedAuth.adminPasswordHash) {
                if (sess.passwordHash) {
                    if (sess.passwordHash !== botState.syncedAuth.adminPasswordHash) {
                        botSessions.delete(token);
                        return null;
                    }
                } else {
                    if (verifyScryptPassword(BOT_ADMIN_PASSWORD, botState.syncedAuth.adminPasswordHash)) {
                        sess.passwordHash = botState.syncedAuth.adminPasswordHash;
                    } else {
                        botSessions.delete(token);
                        return null;
                    }
                }
            }
        } else if (sess.role === 'user') {
            const syncedUsers = Array.isArray(botState.syncedAuth.users) ? botState.syncedAuth.users : [];
            const u = syncedUsers.find(x => x.username.toLowerCase() === (sess.username || '').toLowerCase());
            if (!u) {
                botSessions.delete(token);
                return null;
            }
            if (u.status !== 'active' || (u.expiresAt && Date.now() > Date.parse(u.expiresAt))) {
                botSessions.delete(token);
                return null;
            }
            if (u.passwordHash) {
                if (!sess.passwordHash || sess.passwordHash !== u.passwordHash) {
                    botSessions.delete(token);
                    return null;
                }
            }
        }
    }
    return sess;
}

setInterval(() => {
    const now = Date.now();
    for (const [token, sess] of botSessions.entries()) {
        if (!sess || !sess.expiresAt || now > sess.expiresAt) {
            botSessions.delete(token);
        }
    }
}, 600000);

function timingSafeStringEquals(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getBotSessionFromRequest(req) {
    const authHeader = req.headers['authorization'] || req.headers['x-bot-token'];
    let token = null;
    if (typeof authHeader === 'string') {
        token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    }
    if (!token && req.headers.cookie) {
        token = parseCookies(req).bot_token || null;
    }
    return verifyBotSession(token);
}

function isHttps(req) {
    return !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
}

function serializeBotCookie(name, value, options = {}) {
    let cookie = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
    if (options.maxAge) cookie += `; Max-Age=${options.maxAge}`;
    if (options.secure) cookie += `; Secure`;
    return cookie;
}

function clearBotCookieHeader(name, secure = false) {
    let cookie = `${name}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0`;
    if (secure) cookie += `; Secure`;
    return cookie;
}

function isAdminRequest(req) {
    if (isTrustedManagerRequest(req)) {
        return req.headers['x-manager-role'] === 'admin';
    }
    const session = req.botSession || getBotSessionFromRequest(req);
    return !!session && session.role === 'admin';
}

function canChangeMinecraftAccount(req) {
    if (isTrustedManagerRequest(req)) {
        const headerVal = req.headers['x-manager-allow-account-change'];
        if (headerVal !== undefined) {
            return headerVal === '1' || headerVal === 'true';
        }
        const roleVal = req.headers['x-manager-role'];
        if (roleVal === 'admin') return true;
        return false;
    }
    const session = req.botSession || getBotSessionFromRequest(req);
    if (!session) return false;
    return session.role === 'admin' || session.allowAccountChange !== false;
}

const app = express();

function readPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.trunc(parsed), min), max);
}


// ============================================================================
// HỆ THỐNG TỰ ĐỘNG NHẬN DIỆN NỀN TẢNG THUẦN RENDER CLOUD & PHÁT HIỆN PORT
// ============================================================================

function extractCliArgs() {
    let port = null;
    let platform = null;
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--port=')) {
            const p = parseInt(arg.split('=')[1], 10);
            if (Number.isFinite(p) && p > 0 && p <= 65535) port = p;
        } else if (arg === '--port' || arg === '-p') {
            if (i + 1 < argv.length) {
                const p = parseInt(argv[i + 1], 10);
                if (Number.isFinite(p) && p > 0 && p <= 65535) {
                    port = p;
                    i++;
                }
            }
        } else if (arg.startsWith('-p=')) {
            const p = parseInt(arg.split('=')[1], 10);
            if (Number.isFinite(p) && p > 0 && p <= 65535) port = p;
        } else if (arg.startsWith('--server_port=') || arg.startsWith('--server-port=')) {
            const p = parseInt(arg.split('=')[1], 10);
            if (Number.isFinite(p) && p > 0 && p <= 65535) port = p;
        } else if (arg === '--server_port' || arg === '--server-port') {
            if (i + 1 < argv.length) {
                const p = parseInt(argv[i + 1], 10);
                if (Number.isFinite(p) && p > 0 && p <= 65535) {
                    port = p;
                    i++;
                }
            }
        } else if (arg.startsWith('--web_port=') || arg.startsWith('--web-port=')) {
            const p = parseInt(arg.split('=')[1], 10);
            if (Number.isFinite(p) && p > 0 && p <= 65535) port = p;
        } else if (arg.startsWith('--platform=')) {
            platform = arg.split('=')[1].trim().toLowerCase();
        } else if (arg === '--platform') {
            if (i + 1 < argv.length) {
                platform = argv[i + 1].trim().toLowerCase();
                i++;
            }
        } else if (/^\d{2,5}$/.test(arg) && !port) {
            const p = parseInt(arg, 10);
            if (Number.isFinite(p) && p > 0 && p <= 65535) port = p;
        }
    }
    return { port, platform };
}

function detectHostPlatformAndPort(config, fallbackPort, role = 'bot') {
    const cli = extractCliArgs();

    // 1. Nhận diện nền tảng Hosting (Render Cloud, Deplexo, WispByte, Pterodactyl, Docker, Local):
    const isRender = !!(
        (process.env.RENDER && String(process.env.RENDER).toLowerCase() === 'true') ||
        process.env.RENDER_SERVICE_ID ||
        process.env.RENDER_INSTANCE_ID ||
        process.env.RENDER_SERVICE_NAME ||
        process.env.RENDER_EXTERNAL_HOSTNAME
    );

    const isPanel = !!(
        process.env.PTERODACTYL ||
        process.env.P_SERVER_UUID ||
        process.env.P_SERVER_ALLOCATION_LIMIT ||
        process.env.SERVER_PORT ||
        process.env.P_SERVER_PORT ||
        process.env.STARTUP ||
        process.env.DEPLEXO ||
        process.env.WISPBYTE ||
        process.env.WISPBAY ||
        process.env.WISP
    );

    let platform = isRender ? 'render' : (isPanel ? 'pterodactyl' : 'local');
    let detectionSource = isRender
        ? 'Render Cloud Web Service (process.env.RENDER / RENDER_SERVICE_ID)'
        : (isPanel
            ? 'Hosting Panel / Pterodactyl / Wisp (Deplexo, WispByte, Game Host Container)'
            : 'Môi trường Local PC / VPS độc lập (Universal Mode)');

    const configuredPlatform = String(config.PLATFORM || 'auto').trim().toLowerCase();

    if (cli.platform) {
        platform = cli.platform;
        detectionSource = `Tham số dòng lệnh CLI (--platform=${cli.platform})`;
    } else if (configuredPlatform && configuredPlatform !== 'auto') {
        platform = configuredPlatform;
        detectionSource = `Cấu hình config.PLATFORM = '${configuredPlatform}'`;
    }

    // 2. Phân giải Cổng (Port) thông minh - Ưu tiên thích ứng mọi Hosting
    function isValidPort(p) {
        const n = Number(p);
        return Number.isFinite(n) && n > 0 && n <= 65535;
    }

    let port = fallbackPort || 10000;
    let portSource = 'mặc định';

    if (cli.port && isValidPort(cli.port)) {
        port = Number(cli.port);
        portSource = `Tham số dòng lệnh CLI (--port = ${port})`;
    } else if (isValidPort(process.env.SERVER_PORT)) {
        port = Number(process.env.SERVER_PORT);
        portSource = `Biến môi trường SERVER_PORT = ${port} (WispByte / Deplexo / Pterodactyl)`;
    } else if (isValidPort(process.env.P_SERVER_PORT)) {
        port = Number(process.env.P_SERVER_PORT);
        portSource = `Biến môi trường P_SERVER_PORT = ${port} (Pterodactyl Allocation)`;
    } else if (isValidPort(process.env.ALLOCATION_PORT)) {
        port = Number(process.env.ALLOCATION_PORT);
        portSource = `Biến môi trường ALLOCATION_PORT = ${port}`;
    } else if (isValidPort(process.env.PORT)) {
        port = Number(process.env.PORT);
        portSource = `Biến môi trường PORT = ${port} (Render / Cloud Web Service)`;
    } else if (isValidPort(process.env.APP_PORT)) {
        port = Number(process.env.APP_PORT);
        portSource = `Biến môi trường APP_PORT = ${port}`;
    } else if (isValidPort(process.env.WEB_PORT)) {
        port = Number(process.env.WEB_PORT);
        portSource = `Biến môi trường WEB_PORT = ${port}`;
    } else if (isRender) {
        port = 10000;
        portSource = 'Render Web Service mặc định (10000)';
    } else if (isValidPort(config.WEB_PORT)) {
        port = Number(config.WEB_PORT);
        portSource = `Cấu hình BOT_CONFIG.WEB_PORT = ${port}`;
    } else {
        port = fallbackPort || 10000;
        portSource = `Cổng dự phòng fallback (${port})`;
    }

    return { platform, detectionSource, port, portSource };
}

function listenHttpServer(app, initialPort, platform, onListening) {
    const fixedPort = initialPort;
    const maxRetries = 10;
    let attempt = 0;
    let bindHost = '0.0.0.0';

    function tryListen() {
        const srv = app.listen(fixedPort, bindHost);

        srv.on('listening', () => {
            onListening(srv, fixedPort, bindHost);
        });

        srv.on('error', (err) => {
            if (err.code === 'EADDRNOTAVAIL' && bindHost !== '0.0.0.0') {
                console.warn(`[HTTP] ⚠️ Không thể gán IP ${bindHost} (EADDRNOTAVAIL). Tự động chuyển sang bind '0.0.0.0'...`);
                bindHost = '0.0.0.0';
                setTimeout(tryListen, 500);
                return;
            }

            if (err.code === 'EADDRINUSE' && attempt < maxRetries) {
                attempt++;
                console.warn(`[HTTP] ⚠️ Cổng ${fixedPort} đang tạm thời bận (EADDRINUSE). Đang chờ giải phóng socket và thử lại lần ${attempt}/${maxRetries} sau 1 giây...`);
                setTimeout(tryListen, 1000);
            } else {
                console.error(`[HTTP] ❌ Lỗi khởi động máy chủ web trên cổng ${fixedPort} (IP: ${bindHost}):`, err.message);
                if (err.code === 'EADDRINUSE') {
                    console.error(`[HTTP] 💡 Khắc phục: Cổng ${fixedPort} đang bị chiếm bởi tiến trình khác. Hãy kiểm tra các bot/tiến trình Node.js đang chạy ngầm trên máy.`);
                }
                process.exit(1);
            }
        });
    }

    tryListen();
}


const hostInfo = detectHostPlatformAndPort(BOT_CONFIG, Number(BOT_CONFIG.WEB_PORT) || 10000, 'bot');
const PLATFORM = hostInfo.platform;
let HTTP_PORT = hostInfo.port;

console.log(`[HOST] 🌐 Nền tảng Bot: ${PLATFORM.toUpperCase()} (${hostInfo.detectionSource})`);
console.log(`[HTTP] 🔌 Cổng Web Bot: ${HTTP_PORT} (${hostInfo.portSource})`);

const BOT_ID_RAW = String(BOT_CONFIG.BOT_ID).trim() || '1';
const BOT_ID_NUMBER_PARSED =
    Number.parseInt(BOT_ID_RAW, 10);

const BOT_ID_NUMBER =
    Number.isFinite(BOT_ID_NUMBER_PARSED)
        ? BOT_ID_NUMBER_PARSED
        : 1;

const BOT_ID =
    String(BOT_ID_RAW || BOT_ID_NUMBER);
const BOT_LABEL = `Bot ${BOT_ID}`;

const MAX_LOGS = 500;
const MAX_CHAT_LOGS = 500;
const RECONNECT_DELAY = 3000;
const INVENTORY_ACTION_TIMEOUT_MS = 15000;
const AUTO_START_ON_BOOT = Boolean(BOT_CONFIG.AUTO_START);

// KingMC AFK flow timing.
const DN_TO_AFK_DELAY = 1000;
const AFK_MENU_DELAY = 1800;
const AFK_MENU_CLICK_DELAY = 700;

// Background inventory / survival managers.
const AUTO_EAT_INTERVAL_MS = 2000;
const AUTO_TOTEM_INTERVAL_MS = 1000;
const INVENTORY_SCAN_INTERVAL_MS = 1000;
const SMART_ANTI_AFK_INTERVAL_MS = 38000; // 38s xoay góc nhìn & vung tay nhẹ chống kick

const MC_VERSION = BOT_CONFIG.MC_VERSION;
const HOSTS = Array.isArray(BOT_CONFIG.MC_HOSTS)
    ? BOT_CONFIG.MC_HOSTS
        .map(host => String(host).trim())
        .filter(Boolean)
    : [];
const PORT = readPositiveInt(BOT_CONFIG.MC_PORT, 25565, 1, 65535);

// Network / client-load tuning.
// Mineflayer officially supports far / normal / short / tiny / numeric view distance.
// tiny is the lowest named setting and is appropriate for an AFK bot.
const VIEW_DISTANCE = BOT_CONFIG.VIEW_DISTANCE || 'tiny';
const CHECK_TIMEOUT_INTERVAL = readPositiveInt(
    BOT_CONFIG.CHECK_TIMEOUT_MS,
    30000,
    5000,
    300000
);

const AUTH_COORDS = Object.freeze({
    ...BOT_CONFIG.AUTH_COORDS
});
const LOBBY_COORDS = Object.freeze({
    ...BOT_CONFIG.LOBBY_COORDS
});
const COORD_SCAN_INTERVAL_MS = 250;
const AFK_CONFIRM_DELAY_MS = 700;
const LOCATION_RETRY_BASE_MS = 1000;
const LOCATION_RETRY_MAX_MS = 30000;
const LOCATION_ACTION_COOLDOWN_MS = 2500;
const IP_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

const SETTINGS_FILE = path.join(DATA_DIR, 'bot_settings.json');
const DEFAULT_SETTINGS = Object.freeze({
    ...BOT_CONFIG.DEFAULT_SETTINGS
});

let botFileMasterKey = null;
const botMasterKeyFile = path.join(DATA_DIR, '.bot_master_key');
try {
    if (fs.existsSync(botMasterKeyFile)) {
        botFileMasterKey = fs.readFileSync(botMasterKeyFile, 'utf8').trim();
    } else {
        botFileMasterKey = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(botMasterKeyFile, botFileMasterKey, { encoding: 'utf8', mode: 0o600 });
    }
} catch (_) {}

function getBotCredentialsKeys() {
    const keys = [];
    const primary = String(
        process.env.BOT_CREDENTIALS_ENCRYPTION_KEY ||
        BOT_SECRET_KEY ||
        botFileMasterKey || ''
    ).trim();
    if (primary) {
        keys.push(crypto.createHash('sha256').update(primary).digest());
    }
    if (botFileMasterKey && botFileMasterKey !== primary) {
        keys.push(crypto.createHash('sha256').update(botFileMasterKey).digest());
    }
    return keys;
}

function getBotCredentialsKey() {
    const keys = getBotCredentialsKeys();
    return keys[0] || crypto.createHash('sha256').update('kbot_default_key').digest();
}

function isEncryptedPassword(str) {
    return typeof str === 'string' && (str.startsWith('enc:v1:') || str.startsWith('enc$'));
}

function encryptMinecraftPassword(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') return '';
    return plaintext;
}

function decryptMinecraftPassword(stored) {
    if (!stored || typeof stored !== 'string') return '';
    if (!isEncryptedPassword(stored)) {
        return stored;
    }
    let iv, tag, ciphertext;
    if (stored.startsWith('enc:v1:')) {
        const parts = stored.split(':');
        if (parts.length !== 5) return stored;
        iv = Buffer.from(parts[2], 'hex');
        tag = Buffer.from(parts[3], 'hex');
        ciphertext = parts[4];
    } else if (stored.startsWith('enc$')) {
        const parts = stored.split('$');
        if (parts.length >= 4) {
            iv = Buffer.from(parts[1], 'hex');
            tag = Buffer.from(parts[2], 'hex');
            ciphertext = parts[3];
        } else {
            return stored;
        }
    } else {
        return stored;
    }
    const keys = getBotCredentialsKeys();
    for (const key of keys) {
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            if (decrypted) return decrypted;
        } catch (_) {}
    }
    return stored;
}

const BOT_SCHEDULER_MAX_ITEMS = 50;
const BOT_SCHEDULER_TICK_MS = 1000;
const BOT_SCHEDULER_MANUAL_GUARD_MS = 5000;
const BOT_SCHEDULER_MAX_PHASE_MINUTES = 43200;

function sanitizeAutoChatSchedules(input) {
    if (!Array.isArray(input)) {
        return [];
    }

    const result = [];

    for (const raw of input.slice(0, 100)) {
        if (!raw || typeof raw !== 'object') {
            continue;
        }

        const mode = raw.mode === 'fixed' ? 'fixed' : 'interval';
        const messages = Array.isArray(raw.messages)
            ? raw.messages
                .map(value => String(value ?? '').trim())
                .filter(Boolean)
                .slice(0, 50)
            : [];

        const times = Array.isArray(raw.times)
            ? raw.times
                .map(value => String(value ?? '').trim())
                .filter(value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value))
                .slice(0, 50)
            : [];

        const intervalSeconds = readPositiveInt(
            raw.intervalSeconds,
            3600,
            10,
            7 * 24 * 60 * 60
        );

        const messageDelaySeconds = readPositiveInt(
            raw.messageDelaySeconds,
            2,
            0,
            3600
        );

        if (!messages.length) {
            continue;
        }

        if (mode === 'fixed' && !times.length) {
            continue;
        }

        const id = String(raw.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

        result.push({
            id,
            enabled: raw.enabled !== false,
            mode,
            intervalSeconds,
            times,
            messages,
            messageDelaySeconds,
            lastIntervalRunAt: 0,
            lastFixedRunKey: '',
            running: false
        });
    }

    return result;
}

const RESTRICTED_MINECRAFT_ACCOUNT_COMMANDS = new Set([
    '/register',
    '/reg',
    '/changepassword',
    '/changepass',
    '/cp',
    '/unregister',
    '/unreg',
    '/authme',
    '/user'
]);

function isRestrictedMinecraftAccountCommand(value) {
    const command = String(value || '').trim().toLowerCase().split(/\s+/, 1)[0];
    return RESTRICTED_MINECRAFT_ACCOUNT_COMMANDS.has(command);
}

function hasRestrictedMinecraftAccountCommand(schedules) {
    return Array.isArray(schedules) && schedules.some(schedule =>
        Array.isArray(schedule?.messages) && schedule.messages.some(isRestrictedMinecraftAccountCommand)
    );
}

function sanitizeBotSchedules(input, options = {}) {
    const rawList = Array.isArray(input)
        ? input.filter(item => item && typeof item === 'object')
        : [];

    if (!rawList.length) return [];

    const now = Date.now();
    const resetCycleState = options.resetCycleState === true;
    const rawFirst = rawList[0];
    const requestedMode = rawFirst.mode === 'cycle' ? 'cycle' : 'fixed';
    const id = String(rawFirst.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const enabled = rawFirst.enabled !== false;

    // New format: one scheduler + many ordered items.
    // Legacy v2.1 format: many independent cards. Merge same-mode cards into one scheduler.
    let sourceItems;
    if (Array.isArray(rawFirst.items)) {
        sourceItems = rawFirst.items;
    } else {
        sourceItems = rawList
            .filter(item => (item.mode === 'cycle' ? 'cycle' : 'fixed') === requestedMode)
            .flatMap(item => requestedMode === 'fixed'
                ? [{
                    id: item.id,
                    action: item.action,
                    time: item.time,
                    lastFixedRunKey: item.lastFixedRunKey
                }]
                : [
                    { id: `${item.id || 'cycle'}-stop`, action: 'stop', afterMinutes: item.offAfterMinutes },
                    { id: `${item.id || 'cycle'}-start`, action: 'start', afterMinutes: item.onAfterMinutes }
                ]
            );
    }

    const items = [];
    for (const rawItem of sourceItems.slice(0, BOT_SCHEDULER_MAX_ITEMS)) {
        const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
        const itemId = String(raw.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        const action = raw.action === 'start' ? 'start' : 'stop';

        if (requestedMode === 'fixed') {
            const time = String(raw.time || '').trim();
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) continue;
            items.push({
                id: itemId,
                action,
                time,
                lastFixedRunKey: resetCycleState ? '' : String(raw.lastFixedRunKey || '')
            });
        } else {
            items.push({
                id: itemId,
                action,
                afterMinutes: readPositiveInt(
                    raw.afterMinutes,
                    120,
                    1,
                    BOT_SCHEDULER_MAX_PHASE_MINUTES
                )
            });
        }
    }

    if (!items.length) return [];

    if (requestedMode === 'fixed') {
        const seen = new Set();
        const uniqueItems = items.filter(item => {
            if (seen.has(item.time)) return false;
            seen.add(item.time);
            return true;
        });

        return [{ id, enabled, mode: 'fixed', items: uniqueItems }];
    }

    const rawAnchor = Number(rawFirst.cycleAnchorAt);
    const cycleAnchorAt = resetCycleState
        ? now
        : Number.isFinite(rawAnchor) && rawAnchor > 0
            ? Math.trunc(rawAnchor)
            : now;
    const rawEventIndex = Number(rawFirst.lastCycleEventIndex);
    const lastCycleEventIndex = resetCycleState
        ? 0
        : Number.isInteger(rawEventIndex) && rawEventIndex >= 0
            ? rawEventIndex
            : 0;

    return [{
        id,
        enabled,
        mode: 'cycle',
        items,
        cycleAnchorAt,
        lastCycleEventIndex
    }];
}

// ----------------------------------------------------------------------------
// ENTERPRISE AUTH SYNC & SCRYPT VERIFICATION
// ----------------------------------------------------------------------------
const AUTH_CACHE_FILE = path.join(path.dirname(SETTINGS_FILE), 'bot_auth_cache.json');

function verifyScryptPassword(supplied, stored) {
    if (!supplied || !stored) return false;
    if (!stored.startsWith('scrypt$')) {
        return timingSafeStringEquals(supplied, stored);
    }
    const parts = stored.split('$');
    let salt = '';
    let originalHash = '';
    if (parts.length === 4) {
        salt = parts[2];
        originalHash = parts[3];
    } else if (parts.length === 6) {
        salt = parts[4];
        originalHash = parts[5];
    } else {
        return false;
    }
    try {
        const derivedKey = crypto.scryptSync(supplied, salt, 64, { N: 16384, r: 8, p: 1 });
        const originalBuffer = Buffer.from(originalHash, 'hex');
        if (originalBuffer.length !== derivedKey.length) return false;
        return crypto.timingSafeEqual(originalBuffer, derivedKey);
    } catch (_) {
        return false;
    }
}

function loadBotAuthCache() {
    try {
        if (fs.existsSync(AUTH_CACHE_FILE)) {
            const raw = fs.readFileSync(AUTH_CACHE_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (data && typeof data === 'object') return data;
        }
    } catch (e) {
        console.error('[AUTH_SYNC] Lỗi đọc bot_auth_cache.json:', e.message);
    }
    return null;
}

function saveBotAuthCache(cacheData) {
    try {
        const tmp = AUTH_CACHE_FILE + '.tmp-' + process.pid + '-' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(cacheData, null, 2), 'utf8');
        try {
            fs.renameSync(tmp, AUTH_CACHE_FILE);
        } catch (renameErr) {
            fs.copyFileSync(tmp, AUTH_CACHE_FILE);
            try { fs.unlinkSync(tmp); } catch (_) {}
        }
        return true;
    } catch (e) {
        console.error('[AUTH_SYNC] Lỗi ghi bot_auth_cache.json:', e.message);
        return false;
    }
}

function loadBotSettings() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) {
            return {
                settings: { ...DEFAULT_SETTINGS },
                username: '',
                password: '',
                rawEncryptedPassword: null,
                manuallyStopped: undefined,
                autoChatSchedules: [],
                botSchedules: []
            };
        }

        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        const settings = parsed && typeof parsed.settings === 'object'
            ? parsed.settings
            : {};

        const rawProxyPass = String(settings?.proxy?.password || parsed?.proxy?.password || '');
        const decryptedProxyPass = rawProxyPass ? (isEncryptedPassword(rawProxyPass) ? decryptMinecraftPassword(rawProxyPass) : rawProxyPass) : '';

        const hasSavedCredentials = typeof parsed?.username === 'string';
        return {
            hasSavedCredentials,
            settings: {
                autoTotem: settings.autoTotem !== false,
                antiHungry: settings.antiHungry !== false,
                autoReconnect: settings.autoReconnect !== false,
                antiAfkKick: settings.antiAfkKick !== false,
                ecoMode: settings.ecoMode !== false,
                spawnCommands: typeof settings?.spawnCommands === 'string' ? settings.spawnCommands : (typeof parsed?.spawnCommands === 'string' ? parsed.spawnCommands : ''),
                proxy: {
                    enabled: Boolean(settings?.proxy?.enabled ?? parsed?.proxy?.enabled),
                    protocol: String(settings?.proxy?.protocol || parsed?.proxy?.protocol || 'socks5'),
                    host: String(settings?.proxy?.host || parsed?.proxy?.host || ''),
                    port: Number(settings?.proxy?.port || parsed?.proxy?.port || 0),
                    username: String(settings?.proxy?.username || parsed?.proxy?.username || ''),
                    password: decryptedProxyPass
                }
            },
            username: hasSavedCredentials ? parsed.username : '',
            password: typeof parsed?.password === 'string' ? decryptMinecraftPassword(parsed.password) : '',
            rawEncryptedPassword: (typeof parsed?.password === 'string' && isEncryptedPassword(parsed.password)) ? parsed.password : null,
            manuallyStopped: parsed?.manuallyStopped !== undefined ? !!parsed.manuallyStopped : undefined,
            autoChatSchedules: sanitizeAutoChatSchedules(parsed?.autoChatSchedules),
            botSchedules: sanitizeBotSchedules(parsed?.botSchedules)
        };
    } catch (err) {
        console.error(`[SETTINGS] Không đọc được ${SETTINGS_FILE}: ${err.message}`);
        return {
            settings: { ...DEFAULT_SETTINGS },
            username: '',
            password: '',
            rawEncryptedPassword: null,
            manuallyStopped: undefined,
            autoChatSchedules: [],
            botSchedules: []
        };
    }
}

function saveBotSettingsFile(settings, autoChatSchedules, botSchedules, accountInfo = {}) {
    try {
        const currentUsername = accountInfo.username !== undefined
            ? accountInfo.username
            : (typeof botState !== 'undefined' && botState ? botState.username : '');
        const currentPassword = accountInfo.password !== undefined
            ? accountInfo.password
            : (typeof botState !== 'undefined' && botState ? botState.password : '');
        const currentManuallyStopped = accountInfo.manuallyStopped !== undefined
            ? !!accountInfo.manuallyStopped
            : (typeof botState !== 'undefined' && botState ? !!botState.manuallyStopped : false);

        let savedPassword = '';
        if (accountInfo.password !== undefined) {
            savedPassword = accountInfo.password ? encryptMinecraftPassword(accountInfo.password) : '';
            if (typeof botState !== 'undefined' && botState) {
                botState.rawEncryptedPassword = savedPassword || null;
            }
        } else {
            if (currentPassword) {
                savedPassword = encryptMinecraftPassword(currentPassword);
            } else if (typeof botState !== 'undefined' && botState && botState.rawEncryptedPassword) {
                savedPassword = botState.rawEncryptedPassword;
            }
        }

        const rawProxyPass = String(settings?.proxy?.password || '').trim();
        const savedProxyPass = rawProxyPass ? (isEncryptedPassword(rawProxyPass) ? rawProxyPass : encryptMinecraftPassword(rawProxyPass)) : '';

        const payload = {
            version: 3,
            username: currentUsername || '',
            password: savedPassword,
            manuallyStopped: currentManuallyStopped,
            settings: {
                autoTotem: settings.autoTotem !== false,
                antiHungry: settings.antiHungry !== false,
                autoReconnect: settings.autoReconnect !== false,
                antiAfkKick: settings.antiAfkKick !== false,
                ecoMode: settings.ecoMode !== false,
                spawnCommands: typeof settings?.spawnCommands === 'string' ? settings.spawnCommands.slice(0, 5000) : '',
                proxy: {
                    enabled: settings?.proxy?.enabled === true,
                    protocol: String(settings?.proxy?.protocol || 'socks5').toLowerCase(),
                    host: String(settings?.proxy?.host || '').trim(),
                    port: Number(settings?.proxy?.port) || 0,
                    username: String(settings?.proxy?.username || '').trim(),
                    password: savedProxyPass
                }
            },
            autoChatSchedules: sanitizeAutoChatSchedules(autoChatSchedules)
                .map(schedule => ({
                    id: schedule.id,
                    enabled: schedule.enabled !== false,
                    mode: schedule.mode,
                    intervalSeconds: schedule.intervalSeconds,
                    times: schedule.times,
                    messages: schedule.messages,
                    messageDelaySeconds: schedule.messageDelaySeconds
                })),
            botSchedules: sanitizeBotSchedules(botSchedules)
                .map(schedule => ({
                    id: schedule.id,
                    enabled: schedule.enabled !== false,
                    mode: schedule.mode,
                    items: Array.isArray(schedule.items)
                        ? schedule.items.map(item => schedule.mode === 'fixed'
                            ? {
                                id: item.id,
                                action: item.action === 'start' ? 'start' : 'stop',
                                time: item.time,
                                lastFixedRunKey: item.lastFixedRunKey || ''
                            }
                            : {
                                id: item.id,
                                action: item.action === 'start' ? 'start' : 'stop',
                                afterMinutes: item.afterMinutes
                            })
                        : [],
                    ...(schedule.mode === 'cycle'
                        ? {
                            cycleAnchorAt: schedule.cycleAnchorAt,
                            lastCycleEventIndex: schedule.lastCycleEventIndex
                        }
                        : {})
                }))
        };

        const tmpFile = `${SETTINGS_FILE}.tmp-${process.pid}`;

        fs.writeFileSync(
            tmpFile,
            JSON.stringify(payload, null, 2),
            'utf8'
        );

        try {
            fs.renameSync(
                tmpFile,
                SETTINGS_FILE
            );
        } catch (renameErr) {
            fs.copyFileSync(tmpFile, SETTINGS_FILE);
            try { fs.unlinkSync(tmpFile); } catch (_) {}
        }

        if (typeof botSupabase !== 'undefined' && botSupabase && botSupabase.isEnabled()) {
            void botSupabase.saveBotSettings(payload);
        }

        return true;
    } catch (err) {
        try {
            const tmpFile = `${SETTINGS_FILE}.tmp-${process.pid}`;
            if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        } catch (_) {}
        console.error(`[SETTINGS] Không lưu được ${SETTINGS_FILE}: ${err.message}`);
        return false;
    }
}

const INITIAL_SETTINGS = loadBotSettings();

// 📡 Đo lưu lượng HTTP Express (Tầng 2 cho Network Telemetry)
let cumulativeHttpRxBytes = 0;
let cumulativeHttpTxBytes = 0;

app.set('trust proxy', process.env.TRUST_PROXY ? process.env.TRUST_PROXY : (process.env.RENDER ? 1 : 'loopback'));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; object-src 'none';");
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

function parseCookies(req) {
    const list = {};
    const rc = req.headers?.cookie;
    if (!rc) return list;
    rc.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        const key = parts.shift().trim();
        const rawValue = parts.join('=');
        let value = rawValue;
        try {
            value = decodeURIComponent(rawValue);
        } catch (_) {
            // Ignore malformed escapes safely; they cannot authenticate as a valid session token.
        }
        if (key) list[key] = value;
    });
    return list;
}

function isPrivateOrBlockedHost(hostStr) {
    if (!hostStr || typeof hostStr !== 'string') return true;
    let h = hostStr.trim().toLowerCase().replace(/^\[|\]$/g, '');

    // Hostname chặn metadata và internal domains
    if (['localhost', 'metadata.google.internal', 'metadata.goog', 'instance-data'].includes(h)) return true;
    if (h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.localhost')) return true;

    // Chặn định dạng số nguyên decimal / hex bypass IP (ví dụ: 2130706433 hoặc 0x7f000001)
    if (/^0x[0-9a-f]+$/i.test(h) || /^\d+$/.test(h)) return true;

    // Xử lý IPv4-mapped IPv6, gồm cả dạng hextet để tránh bypass qua ::ffff:7f00:1.
    if (h.startsWith('::ffff:')) {
        const after = h.slice(7);
        if (net.isIPv4(after)) {
            h = after;
        } else {
            const mappedHex = after.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
            if (mappedHex) {
                const high = parseInt(mappedHex[1], 16);
                const low = parseInt(mappedHex[2], 16);
                h = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
            }
        }
    } else {
        const expandedMappedHex = h.match(/^(?:0{1,4}:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
        if (expandedMappedHex) {
            const high = parseInt(expandedMappedHex[1], 16);
            const low = parseInt(expandedMappedHex[2], 16);
            h = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
        } else {
            const expandedMappedIPv4 = h.match(/^(?:0{1,4}:){5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
            if (expandedMappedIPv4) h = expandedMappedIPv4[1];
        }
    }

    const ipType = net.isIP(h);
    if (ipType === 4) {
        const parts = h.split('.').map(p => parseInt(p, 10));
        if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return true;
        const [a, b, c, d] = parts;

        // 0.0.0.0/8 (Mạng hiện tại / Unspecified)
        if (a === 0) return true;
        // 10.0.0.0/8 (Private RFC 1918)
        if (a === 10) return true;
        // 100.64.0.0/10 (Carrier-Grade NAT RFC 6598: 100.64.0.0 - 100.127.255.255)
        if (a === 100 && (b >= 64 && b <= 127)) return true;
        // 127.0.0.0/8 (Loopback RFC 1122)
        if (a === 127) return true;
        // 169.254.0.0/16 (Link-Local RFC 3927)
        if (a === 169 && b === 254) return true;
        // 172.16.0.0/12 (Private RFC 1918: 172.16.0.0 - 172.31.255.255)
        if (a === 172 && (b >= 16 && b <= 31)) return true;
        // 192.0.0.0/24 (IETF Protocol Assignments)
        if (a === 192 && b === 0 && c === 0) return true;
        // 192.0.2.0/24 (TEST-NET-1 RFC 5737)
        if (a === 192 && b === 0 && c === 2) return true;
        // 192.168.0.0/16 (Private RFC 1918)
        if (a === 192 && b === 168) return true;
        // 198.18.0.0/15 (Benchmarking RFC 2544: 198.18.0.0 - 198.19.255.255)
        if (a === 198 && (b === 18 || b === 19)) return true;
        // 198.51.100.0/24 (TEST-NET-2 RFC 5737)
        if (a === 198 && b === 51 && c === 100) return true;
        // 203.0.113.0/24 (TEST-NET-3 RFC 5737)
        if (a === 203 && b === 0 && c === 113) return true;
        // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved) & 255.255.255.255 (Broadcast)
        if (a >= 224) return true;

        return false;
    } else if (ipType === 6) {
        // ::1 Loopback
        if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
        // :: Unspecified
        if (h === '::' || h === '0:0:0:0:0:0:0:0') return true;
        // fe80::/10 (Link-Local)
        if (/^fe[89ab][0-9a-f]/i.test(h) || h.startsWith('fe80:')) return true;
        // fc00::/7 (Unique Local Address - ULA: fc00:: đến fdff::)
        if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
        // ff00::/8 (Multicast)
        if (/^ff[0-9a-f]{2}:/i.test(h)) return true;

        return false;
    }

    return false;
}

async function isPrivateOrBlockedHostAsync(hostStr) {
    if (!hostStr || typeof hostStr !== 'string') return true;
    if (isPrivateOrBlockedHost(hostStr)) return true;
    let h = hostStr.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIP(h) !== 0) return false;
    try {
        const records = await dns.promises.lookup(h, { all: true });
        for (const rec of records) {
            if (isPrivateOrBlockedHost(rec.address)) {
                return true;
            }
        }
        return false;
    } catch (_) {
        return true;
    }
}

// CSRF Origin verification on mutating requests
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (isTrustedManagerRequest(req)) return next();
    if (req.path === '/api/auth/login') return next();
    const cookies = parseCookies(req);
    const hasSessionCookie = !!cookies.bot_token;
    const origin = req.headers['origin'];
    const host = req.headers.host;
    if (hasSessionCookie && !origin && !req.headers['referer']) {
        return res.status(403).json({ ok: false, error: 'Yêu cầu từ trình duyệt thiếu header xác thực nguồn (Origin/Referer).' });
    }
    if (origin) {
        try {
            const parsedOrigin = new URL(origin);
            if (parsedOrigin.host !== host) {
                return res.status(403).json({ ok: false, error: 'CSRF validation failed: Invalid Origin.' });
            }
        } catch (_) {
            return res.status(403).json({ ok: false, error: 'CSRF validation failed: Malformed Origin.' });
        }
    } else if (req.headers['referer'] && host) {
        try {
            const refererHost = new URL(req.headers['referer']).host;
            if (refererHost !== host) {
                return res.status(403).json({ ok: false, error: 'CSRF validation failed: Referer mismatch.' });
            }
        } catch (_) {
            return res.status(403).json({ ok: false, error: 'CSRF validation failed: Malformed Referer.' });
        }
    }
    next();
});

app.use((req, res, next) => {
    let reqBytes = 0;
    req.on('data', chunk => {
        if (chunk) reqBytes += chunk.length;
    });
    const originalWrite = res.write;
    const originalEnd = res.end;
    let resBytes = 0;
    res.write = function(chunk, ...args) {
        if (chunk) resBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        return originalWrite.apply(res, [chunk, ...args]);
    };
    res.end = function(chunk, ...args) {
        if (chunk) resBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        cumulativeHttpRxBytes += reqBytes;
        cumulativeHttpTxBytes += resBytes;
        return originalEnd.apply(res, [chunk, ...args]);
    };
    next();
});

app.use(express.json({ limit: '512kb', strict: true }));

// Cấu hình CORS & Headers để giao tiếp xuyên suốt giữa Web Manager và Bot trên Cloud (Render/VPS)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bot-Secret, X-Manager-Bot-Id');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    if (req.path.startsWith('/api/') || req.path === '/health') {
        res.setHeader(
            'Cache-Control',
            'no-store, no-cache, must-revalidate, proxy-revalidate'
        );
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }

    res.setHeader('X-Bot-ID', BOT_ID);
    res.setHeader('X-Bot-Protocol', '2');

    next();
});

app.use((req, res, next) => {
    const session = getBotSessionFromRequest(req);
    if (session) req.botSession = session;

    if (
        req.path === '/health' ||
        req.path === '/healthz' ||
        req.path === '/api/health' ||
        (req.method === 'GET' && (req.path === '/api/bot' || req.path === '/api/snapshot')) ||
        !req.path.startsWith('/api/') ||
        req.path.startsWith('/api/auth/') ||
        isTrustedManagerRequest(req) ||
        session
    ) {
        return next();
    }

    return res.status(401).json({ ok: false, error: 'Yêu cầu xác thực phiên hoặc X-Bot-Secret hợp lệ.' });
});

app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
        return res.status(400).json({ ok: false, error: 'JSON request không hợp lệ.' });
    }
    return next(err);
});

function cleanMinecraftText(text) {
    if (!text) return '';

    return String(text)
        .replace(/§x(§[0-9a-f]){6}/gi, '')
        .replace(/&x(&[0-9a-f]){6}/gi, '')
        .replace(/&#[0-9a-f]{6}/gi, '')
        .replace(/§#[0-9a-f]{6}/gi, '')
        .replace(/§[0-9a-fk-or]/gi, '')
        .replace(/&[0-9a-fk-or]/gi, '')
        .replace(/§./g, '')
        .replace(/[\u00A0\u200B\uFEFF]/g, ' ')
        .normalize('NFC')
        .trim();
}

function cleanMinecraftComponent(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') {
        return cleanMinecraftText(value);
    }
    if (typeof value === 'object') {
        try {
            if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
                const text = value.toString();
                if (text && text !== '[object Object]') return cleanMinecraftText(text);
            }
            const parts = [];
            if (typeof value.text === 'string') parts.push(value.text);
            if (Array.isArray(value.extra)) {
                for (const child of value.extra) parts.push(cleanMinecraftComponent(child));
            }
            if (parts.length) return cleanMinecraftText(parts.join(''));
        } catch (_) {}
    }
    return '';
}

function getConfiguredCredentials() {
    const envUser = process.env.BOT_USERNAME || process.env.USERNAME || process.env.MC_USERNAME || process.env.KINGMC_USERNAME || '';
    const envPass = process.env.BOT_PASSWORD || process.env.PASSWORD || process.env.MC_PASSWORD || process.env.KINGMC_PASSWORD || '';

    return {
        username: String(BOT_CONFIG.USERNAME || envUser || '').trim(),
        password: String(BOT_CONFIG.PASSWORD || envPass || '')
    };
}

function createBotState() {
    const credentials = getConfiguredCredentials();
    const initialSaved = loadBotSettings();
    const effectiveUsername = initialSaved.hasSavedCredentials
        ? initialSaved.username
        : (credentials.username || '');
    const effectivePassword = initialSaved.hasSavedCredentials
        ? initialSaved.password
        : (credentials.password || '');
    const effectiveManuallyStopped = initialSaved.manuallyStopped !== undefined
        ? initialSaved.manuallyStopped
        : (!effectiveUsername || !effectivePassword);

    return {
        id: BOT_ID_NUMBER,
        botId: BOT_ID,

        username: effectiveUsername,
        password: effectivePassword,
        rawEncryptedPassword: initialSaved.rawEncryptedPassword || null,
        syncedAuth: loadBotAuthCache(),

        bot: null,
        hostIndex: 0,

        status: 'offline',
        ready: false,
        manuallyStopped: effectiveManuallyStopped,
        connectedAt: null,
        stateRevision: 0,
        connectionGeneration: 0,
        restartTimer: null,
        shuttingDown: false,

        // AFK uptime statistics.
        // Uptime counts only while status === 'afk'.
        afkElapsedSeconds: 0,
        afkStartedAt: null,
        reconnectCount: 0,
        reconnectAttempts: 0,

        reconnectTimer: null,
        afkTimers: [],
        locationMonitorTimer: null,
        locationRetryTimer: null,
        locationConfirmTimer: null,
        locationRetryAttempt: 0,
        locationRetryReason: '',
        locationActionBusy: false,
        pendingAfkConfirmation: false,
        locationState: 'unknown',
        menuCommandIndex: 0,
        lastLoginActionAt: 0,
        lastDnActionAt: 0,
        locationFlowBusy: false,
        lastAuthTime: 0,

        inventoryState: {
            revision: 0,
            health: 20,
            food: 20,
            saturation: 20,
            foodCount: 0,
            goldenAppleCount: 0,
            totemCount: 0,
            offhand: null,
            selectedHotbar: 0,
            selectedSlot: 0,
            armor: {
                head: null,
                torso: null,
                legs: null,
                feet: null
            },
            hotbar: [],
            inventory: [],
            slots: {}
        },

        isEating: false,
        inventoryScanTimer: null,
        totemTimer: null,
        eatTimer: null,
        autoChatTimer: null,
        antiAfkTimer: null,
        farmPruneTimer: null,
        memoryWatchdogTimer: null,
        smartWatchdogTimer: null,
        loginFlowStartedAt: null,
        lastPacketReceivedAt: 0,
        deathCount: 0,
        lastDeathAt: 0,
        lastDeathCoords: '',
        lowHealthAlertSent: false,
        lastRssMb: 0,
        lastHeapMb: 0,
        autoChatGeneration: 0,

        settings: { ...INITIAL_SETTINGS.settings },
        autoChatSchedules: INITIAL_SETTINGS.autoChatSchedules,
        botSchedules: INITIAL_SETTINGS.botSchedules,
        botSchedulerTimer: null,
        lastManualLifecycleAt: 0,
        lifecycleActionBusy: false,
        lastAuthDnActionAt: 0,

        publicIp: '',
        publicIpUpdatedAt: 0,
        publicIpTimer: null,

        inventoryLogSignature: '',
        previousInventorySnapshot: null,
        inventoryRevision: 0,
        inventoryActionBusy: false,
        inventoryActionBot: null,
        inventoryActionToken: 0,
        foodMissingLogged: false,
        totemLogState: null,
        isEquippingTotem: false,

        logs: [],
        logRevision: 0,

        chatLogs: [],
        chatLogRevision: 0,
        recentChatMessages: [],
        lastWebChatText: '',
        lastWebChatAt: 0
    };
}

const botState = createBotState();
startBotScheduler(botState);
startMemoryWatchdog(botState);

let lastLoggedMessage = '';
let lastLoggedMessageTime = 0;

function addLog(state, message) {
    if (!message || typeof message !== 'string') return;
    const now = Date.now();

    // Hạn chế log sự kiện trùng lặp / spam liên tục trong vòng 6s
    if (message === lastLoggedMessage && (now - lastLoggedMessageTime < 6000)) {
        return;
    }
    lastLoggedMessage = message;
    lastLoggedMessageTime = now;

    const time = new Date().toLocaleTimeString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false
    });

    const line = `${time} ${message}`;

    state.logs.push(line);
    state.logRevision++;

    if (state.logs.length > MAX_LOGS) {
        state.logs.splice(
            0,
            state.logs.length - MAX_LOGS
        );
    }

    console.log(`[BOT ${state.id}] ${message}`);
}


function addChatLog(
    state,
    username,
    message,
    role = ''
) {
    const time = new Date().toLocaleTimeString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false
    });

    const cleanMessage =
        cleanMinecraftText(message);

    const cleanUsername =
        cleanMinecraftText(username);

    const cleanRole =
        cleanMinecraftText(role);

    if (!cleanMessage) {
        return;
    }

    let line;

    if (cleanRole && cleanUsername) {
        line =
            `${time} ${cleanRole}| ${cleanUsername}: ${cleanMessage}`;
    } else if (cleanUsername) {
        line =
            `${time} <${cleanUsername}> ${cleanMessage}`;
    } else {
        line =
            `${time} ${cleanMessage}`;
    }

    state.chatLogs.push(line);
    state.chatLogRevision++;

    if (state.chatLogs.length > MAX_CHAT_LOGS) {
        state.chatLogs.splice(
            0,
            state.chatLogs.length - MAX_CHAT_LOGS
        );
    }

    state.recentChatMessages.push({
        key:
            `${cleanRole}|${cleanUsername}|${cleanMessage}`,
        role: cleanRole,
        username: cleanUsername,
        text: cleanMessage,
        at: Date.now()
    });

    if (state.recentChatMessages.length > 30) {
        state.recentChatMessages.splice(
            0,
            state.recentChatMessages.length - 30
        );
    }

    console.log(
        `[BOT ${state.id}] [CHAT] ${line}`
    );
}

function isRecentChatMessage(
    state,
    cleanMsg,
    username = '',
    role = ''
) {
    const now = Date.now();
    const wantedText = cleanMinecraftText(cleanMsg);
    const wantedUsername = cleanMinecraftText(username);
    const wantedRole = cleanMinecraftText(role);

    state.recentChatMessages =
        state.recentChatMessages.filter(
            entry => now - entry.at <= 2500
        );

    return state.recentChatMessages.some(
        entry => {
            if (entry.text !== wantedText) {
                return false;
            }

            if (
                wantedUsername &&
                entry.username &&
                entry.username !== wantedUsername
            ) {
                return false;
            }

            if (
                wantedRole &&
                entry.role &&
                entry.role !== wantedRole
            ) {
                return false;
            }

            return true;
        }
    );
}

function parseCustomChatLine(cleanMsg) {
    const candidate =
        cleanMsg.replace(
            /^\[MC\]\s*/i,
            ''
        );

    const match =
        candidate.match(
            /^(.+?)\|\s*([A-Za-z0-9_]{1,16})\s*:\s*(.+)$/u
        );

    if (!match) {
        return null;
    }

    const role =
        cleanMinecraftText(match[1]);

    const username =
        cleanMinecraftText(match[2]);

    const message =
        cleanMinecraftText(match[3]);

    if (
        !role ||
        !username ||
        !message
    ) {
        return null;
    }

    return {
        role,
        username,
        message
    };
}

function isCurrentBot(state, bot) {
    return !!bot && state.bot === bot;
}

function beginInventoryAction(state, bot) {
    state.inventoryActionBusy = true;
    state.inventoryActionBot = bot;
    state.inventoryActionToken++;
    return state.inventoryActionToken;
}

function endInventoryAction(state, bot, token) {
    if (
        state.inventoryActionBot === bot &&
        state.inventoryActionToken === token
    ) {
        state.inventoryActionBusy = false;
        state.inventoryActionBot = null;
    }
}

function isInventoryActionCurrent(state, bot, token) {
    return (
        state.bot === bot &&
        state.inventoryActionBot === bot &&
        state.inventoryActionToken === token &&
        !state.manuallyStopped
    );
}

function invalidateInventoryAction(state) {
    state.inventoryActionToken++;
    state.inventoryActionBusy = false;
    state.inventoryActionBot = null;
}

function cleanupBotResources(bot) {
    if (!bot) return;

    try {
        bot.removeAllListeners();
        // Keep a no-op error listener so a late EventEmitter 'error' from a
        // fully disconnected client can never become an uncaught exception.
        bot.on('error', () => {});
    } catch (_) {
    }

    const client = bot._client;

    if (!client) return;

    try {
        if (typeof client.removeAllListeners === 'function') {
            client.removeAllListeners();
        }
        if (typeof client.on === 'function') {
            client.on('error', () => {});
        }
    } catch (_) {
    }

    try {
        const socket = client.socket;
        if (socket && typeof socket.destroy === 'function' && !socket.destroyed) {
            socket.destroy();
        }
    } catch (_) {
    }

    try {
        if (bot.world && bot.world.columns) {
            bot.world.columns = {};
        }
        if (bot.entities) {
            bot.entities = {};
        }
        if (bot.inventory) {
            bot.inventory.slots = [];
        }
    } catch (_) {}

    // Thu hồi bộ nhớ Heap thực sự sau khi đóng/dọn dẹp tài nguyên bot
    runGarbageCollection();
}

function withTimeout(
    promise,
    timeoutMs,
    label = 'Thao tác',
    onTimeout = null
) {
    let timer = null;

    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (typeof onTimeout === 'function') {
                try {
                    onTimeout();
                } catch (_) {
                }
            }

            reject(new Error(`${label} quá thời gian chờ.`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function clearAfkTimers(state) {
    for (const timer of state.afkTimers) {
        clearTimeout(timer);
    }

    state.afkTimers = [];
}

function clearReconnectTimer(state) {
    if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
    }
}

function clearManagerTimers(state) {
    if (state.eatTimer) {
        clearInterval(state.eatTimer);
        state.eatTimer = null;
    }

    if (state.totemTimer) {
        clearInterval(state.totemTimer);
        state.totemTimer = null;
    }

    if (state.inventoryScanTimer) {
        clearInterval(state.inventoryScanTimer);
        state.inventoryScanTimer = null;
    }

    if (state.autoChatTimer) {
        clearInterval(state.autoChatTimer);
        state.autoChatTimer = null;
    }

    if (state.antiAfkTimer) {
        clearInterval(state.antiAfkTimer);
        state.antiAfkTimer = null;
    }

    if (state.farmPruneTimer) {
        clearInterval(state.farmPruneTimer);
        state.farmPruneTimer = null;
    }

    if (state.smartWatchdogTimer) {
        clearInterval(state.smartWatchdogTimer);
        state.smartWatchdogTimer = null;
    }

    state.autoChatGeneration++;

    state.isEating = false;
    state.isEquippingTotem = false;
}

function clearRestartTimer(state) {
    if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }
}

function clearPublicIpTimer(state) {
    if (state.publicIpTimer) {
        clearInterval(state.publicIpTimer);
        state.publicIpTimer = null;
    }
}

function clearLocationTimers(state) {
    if (state.locationMonitorTimer) {
        clearInterval(state.locationMonitorTimer);
        state.locationMonitorTimer = null;
    }

    if (state.locationRetryTimer) {
        clearTimeout(state.locationRetryTimer);
        state.locationRetryTimer = null;
    }

    if (state.locationConfirmTimer) {
        clearTimeout(state.locationConfirmTimer);
        state.locationConfirmTimer = null;
    }

    state.locationActionBusy = false;
    state.locationFlowBusy = false;
    state.pendingAfkConfirmation = false;
    state.locationRetryAttempt = 0;
    state.locationRetryReason = '';
}

function clearAllTimers(state, includePublicIp = false) {
    clearAfkTimers(state);
    clearReconnectTimer(state);
    clearLocationTimers(state);
    clearRestartTimer(state);
    clearManagerTimers(state);

    if (includePublicIp) {
        clearPublicIpTimer(state);
    }
}

// ============================================================================
// 🌟 MODULE SIÊU TỐI ƯU CHO KHU FARM KELP / MOB (HƠN 100K+ ITEMS)
// ============================================================================
function applyHighDensityFarmOptimizations(state, bot) {
    if (!BOT_CONFIG.FARM_OPTIMIZATION.ENABLED || !bot) return;

    // 1. Chặn hoàn toàn Packet hạt bọt nước, âm thanh & animation rớt item
    if (BOT_CONFIG.FARM_OPTIMIZATION.DROP_PARTICLES_AND_SOUNDS && bot._client) {
        const dropEvents = [
            'world_particles', 'sound_effect', 'named_sound_effect', 'update_light',
            'spawn_entity_experience_orb', 'experience_orb', 'explosion',
            'block_break_animation', 'entity_effect', 'remove_entity_effect'
        ];
        for (const evt of dropEvents) {
            // Không xóa listener nội bộ của Mineflayer bằng removeAllListeners
            if (bot._client.listenerCount(evt) === 0) {
                bot._client.on(evt, () => {});
            }
        }
    }

    // 2. Hủy bỏ triệt để việc xóa bot.entities (tránh tạo vòng lặp tái sinh entity vô tận làm đơ/loop Eco mode)
    if (bot._entitySpawnPruneHandler) {
        bot.removeListener('entitySpawn', bot._entitySpawnPruneHandler);
        bot._entitySpawnPruneHandler = null;
    }

    // 3. Vòng lặp dọn dẹp Chunk bản đồ ở xa (> 2 chunks) để giải phóng RAM triệt để
    if (state.farmPruneTimer) clearInterval(state.farmPruneTimer);
    const pruneInterval = Number(BOT_CONFIG.FARM_OPTIMIZATION.PRUNE_INTERVAL_MS) || 20000;
    state.farmPruneTimer = setInterval(() => {
        try {
            if (!bot) return;
            const myPos = bot.entity ? bot.entity.position : null;

            // Dọn dẹp an toàn các chunk map ngoài bán kính quanh bot
            if (bot.world && myPos) {
                const botChunkX = Math.floor(myPos.x / 16);
                const botChunkZ = Math.floor(myPos.z / 16);
                const cullRadius = Number(BOT_CONFIG.FARM_OPTIMIZATION.CHUNK_CULL_RADIUS) || 2;

                if (typeof bot.world.getColumns === 'function') {
                    const cols = bot.world.getColumns();
                    if (Array.isArray(cols)) {
                        for (const col of cols) {
                            if (!col) continue;
                            const cx = col.chunkX ?? col.x;
                            const cz = col.chunkZ ?? col.z;
                            if (cx !== undefined && cz !== undefined) {
                                if (Math.abs(cx - botChunkX) > cullRadius || Math.abs(cz - botChunkZ) > cullRadius) {
                                    if (typeof bot.world.unloadColumn === 'function') {
                                        bot.world.unloadColumn(cx, cz);
                                    } else if (bot.world.columns) {
                                        delete bot.world.columns[`${cx},${cz}`];
                                    }
                                }
                            }
                        }
                    }
                } else if (bot.world.columns) {
                    for (const key of Object.keys(bot.world.columns)) {
                        const parts = key.split(',');
                        if (parts.length === 2) {
                            const cx = parseInt(parts[0], 10);
                            const cz = parseInt(parts[1], 10);
                            if (Math.abs(cx - botChunkX) > cullRadius || Math.abs(cz - botChunkZ) > cullRadius) {
                                if (typeof bot.world.unloadColumn === 'function') {
                                    bot.world.unloadColumn(cx, cz);
                                } else {
                                    delete bot.world.columns[key];
                                }
                            }
                        }
                    }
                }
            }
        } catch (_) {}
    }, pruneInterval);
}

// 🌿 ECO MODE ENGINE: Siêu Tối Ưu RAM & CPU cho Hạm Đội
function applyEcoModeOptimizations(state, bot) {
    if (!bot) return;
    const isEco = state.settings.ecoMode !== false;

    if (isEco) {
        if (bot.physics) {
            bot.physics.maxCatchupTicks = 0;
        }

        // BẢO ĐẢM PHYSICS TICK LUÔN BẬT để server KingMC không kick do mất gói tin / timeout
        bot.physicsEnabled = true;

        // Hạ CPU ~80%: triệt tiêu tính toán gia tốc khi bot đang AFK đứng yên
        if (state.status === 'afk' && !state.isEating && !state.locationFlowBusy) {
            try {
                if (typeof bot.clearControlStates === 'function') {
                    bot.clearControlStates();
                }
                if (bot.entity && bot.entity.velocity) {
                    bot.entity.velocity.set(0, 0, 0);
                }
            } catch (_) {}
        }

        // Cắt tỉa logs trong RAM
        if (state.logs && state.logs.length > 150) state.logs = state.logs.slice(-150);
        if (state.chatLogs && state.chatLogs.length > 150) state.chatLogs = state.chatLogs.slice(-150);

        // Dọn dẹp an toàn các chunk bản đồ ở xa (> 2 chunk quanh bot) để giải phóng hàng chục MB RAM
        try {
            if (bot.world) {
                const myPos = bot.entity ? bot.entity.position : null;
                if (myPos) {
                    const myCx = Math.floor(myPos.x / 16);
                    const myCz = Math.floor(myPos.z / 16);
                    if (bot.world.columns) {
                        for (const key of Object.keys(bot.world.columns)) {
                            const parts = key.split(',');
                            if (parts.length === 2) {
                                const cx = parseInt(parts[0], 10);
                                const cz = parseInt(parts[1], 10);
                                if (Math.abs(cx - myCx) > 2 || Math.abs(cz - myCz) > 2) {
                                    if (typeof bot.world.unloadColumn === 'function') {
                                        bot.world.unloadColumn(cx, cz);
                                    } else {
                                        delete bot.world.columns[key];
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (_) {}

        // Kích hoạt V8 Garbage Collection giải phóng bộ nhớ Heap thực sự
        runGarbageCollection();
    } else {
        bot.physicsEnabled = true;
    }
}

// 🛡️ MEMORY WATCHDOG: Giám sát RAM định kỳ, bảo đảm luôn < 220MB (Eco) / < 380MB
let lastMemCleanLogTime = 0;

function startMemoryWatchdog(state) {
    if (state.memoryWatchdogTimer) clearInterval(state.memoryWatchdogTimer);
    state.memoryWatchdogTimer = setInterval(() => {
        try {
            const memBefore = process.memoryUsage();
            const rssMb = Math.round(memBefore.rss / (1024 * 1024));
            const heapMb = Math.round(memBefore.heapUsed / (1024 * 1024));
            state.lastRssMb = rssMb;
            state.lastHeapMb = heapMb;

            const isEco = state.settings.ecoMode !== false;
            const hostTotalMb = typeof getContainerMemoryLimit === 'function' ? getContainerMemoryLimit() : 512;
            let limitMb;
            if (isEco) {
                limitMb = Math.min(220, Math.max(120, Math.round(hostTotalMb * 0.5)));
            } else {
                const configLimit = Number(BOT_CONFIG.RAM_WATCHDOG_LIMIT_MB) || 380;
                limitMb = Math.min(configLimit, Math.max(160, Math.round(hostTotalMb * 0.75)));
            }
            if (rssMb > limitMb || heapMb > (limitMb * 0.75)) {
                // 1. Dọn dẹp an toàn chunk ở xa
                if (state.bot && state.bot.world) {
                    const myPos = state.bot.entity ? state.bot.entity.position : null;
                    if (myPos && state.bot.world.columns) {
                        const myCx = Math.floor(myPos.x / 16);
                        const myCz = Math.floor(myPos.z / 16);
                        for (const key of Object.keys(state.bot.world.columns)) {
                            const parts = key.split(',');
                            if (parts.length === 2) {
                                const cx = parseInt(parts[0], 10);
                                const cz = parseInt(parts[1], 10);
                                if (Math.abs(cx - myCx) > 2 || Math.abs(cz - myCz) > 2) {
                                    if (typeof state.bot.world.unloadColumn === 'function') {
                                        state.bot.world.unloadColumn(cx, cz);
                                    } else {
                                        delete state.bot.world.columns[key];
                                    }
                                }
                            }
                        }
                    }
                }

                // 2. Cắt tỉa logs trong RAM
                const maxLogs = isEco ? 150 : 300;
                if (state.logs && state.logs.length > maxLogs) state.logs = state.logs.slice(-maxLogs);
                if (state.chatLogs && state.chatLogs.length > maxLogs) state.chatLogs = state.chatLogs.slice(-maxLogs);

                // 3. Thực thi Garbage Collection giải phóng bộ nhớ
                runGarbageCollection();

                const memAfter = process.memoryUsage();
                state.lastRssMb = Math.round(memAfter.rss / (1024 * 1024));
                state.lastHeapMb = Math.round(memAfter.heapUsed / (1024 * 1024));

                // 4. Rate-limit log sự kiện (chỉ log tối đa 1 lần mỗi 10 phút, không spam liên tục)
                const now = Date.now();
                if (now - lastMemCleanLogTime > 600000) {
                    lastMemCleanLogTime = now;
                    addLog(state, `[BỘ NHỚ] 🌿 Đã giải phóng RAM (RSS: ${rssMb}MB → ${state.lastRssMb}MB | Heap: ${state.lastHeapMb}MB).`);
                }
            }

            if (state.bot) {
                applyEcoModeOptimizations(state, state.bot);
            }
        } catch (_) {}
    }, 25000);
}

// ⚡ SMART FLEET WATCHDOG: Chống treo Lobby (>28s) & Chống Ghost Packet Freeze (>35s)
function startSmartWatchdog(state) {
    if (state.smartWatchdogTimer) clearInterval(state.smartWatchdogTimer);
    state.smartWatchdogTimer = setInterval(() => {
        try {
            if (state.shuttingDown || state.manuallyStopped || !state.settings.autoReconnect) return;
            const now = Date.now();
            const bot = state.bot;
            if (!bot) return;

            // 1. WATCHDOG CHỐNG TREO SẢNH (Lobby-Stuck Watchdog: kẹt login/lobby > 28s)
            const isInConnectingFlow = ['connecting', 'authenticating', 'entering'].includes(state.status);
            if (isInConnectingFlow && state.loginFlowStartedAt && (now - state.loginFlowStartedAt >= 28000)) {
                addLog(state, `[WATCHDOG] ⚠️ Kẹt ở quy trình đăng nhập/sảnh quá ${Math.round((now - state.loginFlowStartedAt) / 1000)}s! Đang tự động Hard Reconnect...`);
                sendBotDirectAlert('lobby_stuck', 'Bot bị kẹt ở Sảnh/Lobby quá 28s không thể chuyển Server AFK. Đang tự động reset và kết nối lại.');
                state.loginFlowStartedAt = null;
                disconnectBot(state, 'Lobby Stuck Watchdog');
                scheduleReconnect(state);
                return;
            }

            // 2. WATCHDOG CHỐNG ĐỨT MẠNG NGẦM (Ghost Packet Freeze: AFK > 35s không nhận được packet)
            const isAfkOrOnline = state.status === 'afk' || state.status === 'online';
            if (isAfkOrOnline && state.lastPacketReceivedAt && (now - state.lastPacketReceivedAt >= 35000)) {
                addLog(state, `[WATCHDOG] ⚠️ Phát hiện Ghost Freeze (${Math.round((now - state.lastPacketReceivedAt) / 1000)}s không có gói tin nào từ KingMC). Đang khôi phục kết nối...`);
                sendBotDirectAlert('ghost_freeze', 'Phát hiện Ghost Freeze (35s đứt kết nối ngầm không nhận gói tin). Đang tự phục hồi.');
                state.lastPacketReceivedAt = null;
                disconnectBot(state, 'Ghost Packet Freeze');
                scheduleReconnect(state);
                return;
            }
        } catch (_) {}
    }, 5000);
}

// ============================================================================
// HỆ THỐNG CẢNH BÁO DISCORD & TELEGRAM WEBHOOK TRỰC TIẾP TỪ BOT
// ============================================================================
function getBotDiscordWebhookUrl() {
    return String(
        BOT_CONFIG.DISCORD_WEBHOOK_URL ||
        process.env.DISCORD_WEBHOOK_URL ||
        process.env.BOT_DISCORD_WEBHOOK ||
        process.env.WEBHOOK_URL ||
        ''
    ).trim();
}

function getBotTelegramConfig() {
    return {
        token: String(BOT_CONFIG.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
        chatId: String(BOT_CONFIG.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim()
    };
}

async function sendTelegramMessage(token, chatId, text) {
    if (!token || !chatId) return false;
    try {
        const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'HTML'
            })
        });
        return response.ok;
    } catch (_) {
        return false;
    }
}

async function sendBotDirectAlert(eventType, message, details = {}) {
    const webhookUrl = getBotDiscordWebhookUrl();
    const tg = getBotTelegramConfig();
    if (!webhookUrl && (!tg.token || !tg.chatId)) return;

    let color = 0x3498DB;
    let emoji = '🤖';
    if (eventType === 'kicked' || eventType === 'error') { color = 0xE74C3C; emoji = '🚨'; }
    else if (eventType === 'death') { color = 0xC0392B; emoji = '💀'; }
    else if (eventType === 'low_health') { color = 0xE67E22; emoji = '⚠️'; }
    else if (eventType === 'totem_popped') { color = 0xF1C40F; emoji = '🪙'; }
    else if (eventType === 'lobby_stuck' || eventType === 'ghost_freeze') { color = 0xE74C3C; emoji = '⚡'; }
    else if (eventType === 'spawn' || eventType === 'afk') { color = 0x2ECC71; emoji = '✅'; }

    // 1. Gửi Discord nếu có webhookUrl
    if (webhookUrl) {
        const fields = [
            { name: '👤 Bot ID / Label', value: `${BOT_LABEL} (ID: ${BOT_ID})`, inline: true },
            { name: '🌐 Trạng thái', value: eventType.toUpperCase(), inline: true }
        ];
        for (const [k, v] of Object.entries(details)) {
            fields.push({ name: k, value: String(v), inline: true });
        }

        try {
            await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: `KingMC Bot ${BOT_LABEL}`,
                    embeds: [{
                        title: `${emoji} [${eventType.toUpperCase()}] ${BOT_LABEL}`,
                        description: message,
                        color,
                        fields,
                        timestamp: new Date().toISOString()
                    }]
                })
            });
        } catch (_) {}
    }

    // 2. Gửi Telegram nếu có token & chatId
    if (tg.token && tg.chatId) {
        let tgText = `<b>${emoji} [${eventType.toUpperCase()}] ${BOT_LABEL} (ID: ${BOT_ID})</b>\n`;
        tgText += `${message}\n`;
        for (const [k, v] of Object.entries(details)) {
            tgText += `• <b>${k}:</b> ${v}\n`;
        }
        await sendTelegramMessage(tg.token, tg.chatId, tgText);
    }
}

// ⚡ INSTANT AUTO TOTEM: Phản xạ tức thì (< 50ms khi nhận damage)
async function fastEquipTotem(state) {
    const bot = state.bot;
    if (!state.settings.autoTotem || !bot || !bot.inventory || state.isEquippingTotem) return;

    const offhandSlot = getOffhandSlot(bot);
    const offhandItem = bot.inventory.slots[offhandSlot];
    if (offhandItem && offhandItem.name === 'totem_of_undying') return;

    if (state.status === 'afk' && bot.currentWindow && typeof bot.closeWindow === 'function') {
        try { bot.closeWindow(bot.currentWindow); } catch (_) {}
    }
    if (bot.usingHeldItem && typeof bot.deactivateItem === 'function') {
        try { bot.deactivateItem(); } catch (_) {}
    }
    state.isEating = false;

    let totemItem = null;
    for (let slot = 9; slot <= 44; slot++) {
        const item = bot.inventory.slots[slot];
        if (item && item.name === 'totem_of_undying') {
            totemItem = item;
            break;
        }
    }
    if (!totemItem) return;

    state.isEquippingTotem = true;
    try {
        await bot.equip(totemItem, 'off-hand');
        addLog(state, '⚡ [TOTEM] Phản xạ tức thì: Đã lắp Totem vào tay phụ!');
        scanInventory(state, bot);
    } catch (_) {} finally {
        state.isEquippingTotem = false;
    }
}

// 🔄 SMART ANTI-AFK KICK: Giả lập hành vi người chơi thật (Natural Cadence, Micro-Look, Swing, Sneak)
function startSmartAntiAfk(state) {
    if (state.antiAfkTimer) {
        clearTimeout(state.antiAfkTimer);
        clearInterval(state.antiAfkTimer);
        state.antiAfkTimer = null;
    }

    function scheduleNext() {
        if (!state.settings.antiAfkKick || state.status !== 'afk' || !state.ready || !state.bot) return;

        // Tần số ngẫu nhiên tự nhiên (22s - 45s) tránh quy luật cố định
        const jitterInterval = 22000 + Math.floor(Math.random() * 23000);
        state.antiAfkTimer = setTimeout(() => {
            if (state.settings.antiAfkKick && state.status === 'afk' && state.ready && state.bot && state.bot.entity) {
                try {
                    const deltaYaw = (Math.random() - 0.5) * 0.35;
                    const deltaPitch = (Math.random() - 0.5) * 0.2;
                    const yaw = state.bot.entity.yaw + deltaYaw;
                    const pitch = Math.max(-1.4, Math.min(1.4, state.bot.entity.pitch + deltaPitch));

                    // Bật physics 1500ms để server KingMC nhận diện chuyển động tự nhiên
                    state.bot.physicsEnabled = true;
                    state.bot.look(yaw, pitch, true, () => {
                        // 40% cơ hội vung tay (swingArm packet)
                        if (Math.random() > 0.6 && typeof state.bot.swingArm === 'function') {
                            state.bot.swingArm('right');
                        }
                        // 25% cơ hội nhấp ngồi (sneak) 160ms giả lập thao tác người thật
                        if (Math.random() > 0.75 && typeof state.bot.setControlState === 'function') {
                            try { state.bot.setControlState('sneak', true); } catch (_) {}
                            setTimeout(() => {
                                try {
                                    if (state.bot && typeof state.bot.setControlState === 'function') {
                                        state.bot.setControlState('sneak', false);
                                    }
                                } catch (_) {}
                            }, 160);
                        }
                    });
                    setTimeout(() => {
                        if (state.bot) {
                            applyEcoModeOptimizations(state, state.bot);
                        }
                    }, 1500);
                } catch (_) {}
            }
            scheduleNext();
        }, jitterInterval);
    }

    scheduleNext();
}

// 🚀 AUTO-SPAWN ACTION ROUTINE: Tự động chạy chuỗi lệnh sau khi vào server thành công
function runSpawnCommands(state, bot) {
    const raw = String(state.settings?.spawnCommands || '').trim();
    if (!raw) return;
    const cmds = raw.split(/[\r\n;]+/).map(s => s.trim()).filter(Boolean);
    if (cmds.length === 0) return;

    addLog(state, `[SPAWN-CMD] 🚀 Đang khởi chạy chuỗi ${cmds.length} lệnh tự động sau khi vào server...`);
    let idx = 0;
    function next() {
        if (idx >= cmds.length) {
            addLog(state, `[SPAWN-CMD] ✅ Đã hoàn tất chuỗi lệnh tự động.`);
            return;
        }
        if (state.status !== 'afk' || state.bot !== bot || !state.ready) {
            addLog(state, `[SPAWN-CMD] ⚠️ Tạm dừng chuỗi lệnh do trạng thái bot không còn AFK.`);
            return;
        }
        const cmd = cmds[idx++];
        const formatted = cmd.startsWith('/') ? cmd : '/' + cmd;
        try {
            addLog(state, `[SPAWN-CMD] ❯ Gửi lệnh: ${formatted}`);
            bot.chat(formatted);
        } catch (e) {
            addLog(state, `[SPAWN-CMD] ❌ Lỗi gửi lệnh (${formatted}): ${e.message}`);
        }
        setTimeout(next, 1600);
    }
    setTimeout(next, 2000);
}


const FOOD_PRIORITY = [
    'golden_apple',
    'cooked_beef',
    'cooked_porkchop',
    'cooked_chicken',
    'baked_potato',
    'bread',
    'cooked_mutton',
    'cooked_salmon'
];

function rememberSelectedSlot(state) {
    if (
        !state.bot ||
        !Number.isInteger(state.bot.quickBarSlot)
    ) {
        return 0;
    }

    const slot = state.bot.quickBarSlot;

    if (slot < 0 || slot > 8) {
        return 0;
    }

    return slot;
}

function restoreSelectedSlot(state, slot) {
    if (
        !state.bot ||
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot > 8 ||
        typeof state.bot.setQuickBarSlot !== 'function'
    ) {
        return false;
    }

    try {
        state.bot.setQuickBarSlot(slot);
        return true;
    } catch (err) {
        addLog(
            state,
            `[HOTBAR] Không thể khôi phục slot ${slot}: ${err.message}`
        );
        return false;
    }
}

function selectHotbarSlot(state, slot) {
    if (
        !state.bot ||
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot > 8 ||
        typeof state.bot.setQuickBarSlot !== 'function'
    ) {
        return false;
    }

    try {
        state.bot.setQuickBarSlot(slot);
        return true;
    } catch (err) {
        addLog(
            state,
            `[HOTBAR] Không thể chọn slot ${slot}: ${err.message}`
        );
        return false;
    }
}

function resetInventoryState(state) {
    state.inventoryRevision++;
    invalidateInventoryAction(state);

    state.inventoryState = {
        revision: state.inventoryRevision,
        health: 20,
        food: 20,
        saturation: 20,
        foodCount: 0,
        goldenAppleCount: 0,
        totemCount: 0,
        offhand: null,
        selectedHotbar: 0,
        selectedSlot: 0,
        armor: {
            head: null,
            torso: null,
            legs: null,
            feet: null
        },
        hotbar: [],
        inventory: [],
        slots: {}
    };

    state.inventoryLogSignature = '';
    state.previousInventorySnapshot = null;
    state.inventoryActionBusy = false;
    state.foodMissingLogged = false;
    state.totemLogState = null;
    state.isEquippingTotem = false;
}

function getOffhandSlot(bot) {
    if (
        bot &&
        typeof bot.getEquipmentDestSlot === 'function'
    ) {
        try {
            return bot.getEquipmentDestSlot('off-hand');
        } catch (_) {
        }
    }

    return 45;
}

function itemToInventoryData(item, slot = null) {
    if (!item) {
        return null;
    }

    return {
        slot:
            Number.isInteger(slot)
                ? slot
                : Number.isInteger(item.slot)
                    ? item.slot
                    : null,
        name: item.name || '',
        displayName:
            item.displayName ||
            item.name ||
            '',
        count:
            Number(item.count || 0),
        metadata:
            item.metadata ?? null
    };
}

function getSlotLabel(slot) {
    if (slot >= 36 && slot <= 44) {
        return `HOTBAR ${slot - 35}`;
    }

    if (slot >= 9 && slot <= 35) {
        return `INV ${slot}`;
    }

    if (slot === 5) return 'ARMOR head';
    if (slot === 6) return 'ARMOR torso';
    if (slot === 7) return 'ARMOR legs';
    if (slot === 8) return 'ARMOR feet';
    if (slot === 45) return 'OFFHAND';

    return `SLOT ${slot}`;
}

function itemSummary(item) {
    if (!item) {
        return 'empty';
    }

    const count =
        Number(item.count || 0);

    return `${item.displayName || item.name || 'unknown'} x${count}`;
}

function itemSignature(item) {
    if (!item) {
        return 'empty';
    }

    return [
        item.name || '',
        Number(item.count || 0),
        item.metadata ?? ''
    ].join('|');
}

function buildSlotState(slots) {
    const slotState = {};

    for (let slot = 5; slot <= 45; slot++) {
        slotState[String(slot)] =
            itemToInventoryData(
                slots[slot] || null,
                slot
            );
    }

    return slotState;
}

function buildInventorySnapshot(
    nextState
) {
    const slotSignatures = {};
    const slotSummaries = {};

    const slots =
        nextState.slots || {};

    for (
        let slot = 5;
        slot <= 45;
        slot++
    ) {
        const key = String(slot);
        const item =
            slots[key] || null;

        slotSignatures[key] =
            itemSignature(item);

        slotSummaries[key] =
            itemSummary(item);
    }

    return {
        health:
            Number(nextState.health ?? 20),
        food:
            Number(nextState.food ?? 20),
        saturation:
            Number(nextState.saturation ?? 20),
        foodCount:
            Number(nextState.foodCount ?? 0),
        goldenAppleCount:
            Number(nextState.goldenAppleCount ?? 0),
        totemCount:
            Number(nextState.totemCount ?? 0),
        selectedSlot:
            Number(nextState.selectedSlot ?? 0),
        slotSignatures,
        slotSummaries
    };
}

function countSlotChanges(
    previous,
    next,
    start,
    end
) {
    let count = 0;

    const previousSignatures =
        previous?.slotSignatures || {};

    const nextSignatures =
        next?.slotSignatures || {};

    for (
        let slot = start;
        slot <= end;
        slot++
    ) {
        const key = String(slot);

        if (
            previousSignatures[key] !==
            nextSignatures[key]
        ) {
            count++;
        }
    }

    return count;
}

function logInventoryDifferences(
    state,
    previous,
    next
) {
    if (!previous) {
        addLog(
            state,
            '[INV] Inventory đã đồng bộ lần đầu.'
        );
        return;
    }

    const previousHealth =
        Number(previous.health ?? 20);

    const nextHealth =
        Number(next.health ?? 20);

    if (
        previousHealth !==
        nextHealth
    ) {
        addLog(
            state,
            `[HEALTH] ${previousHealth} → ${nextHealth} HP.`
        );
    }

    const previousFood =
        Number(previous.food ?? 20);

    const nextFood =
        Number(next.food ?? 20);

    if (
        previousFood !==
        nextFood
    ) {
        addLog(
            state,
            `[FOOD] Hunger ${previousFood} → ${nextFood}.`
        );
    }

    const previousFoodCount =
        Number(previous.foodCount ?? 0);

    const nextFoodCount =
        Number(next.foodCount ?? 0);

    if (
        previousFoodCount !==
        nextFoodCount
    ) {
        addLog(
            state,
            `[INV] Tổng thức ăn ${previousFoodCount} → ${nextFoodCount}.`
        );
    }

    const previousGolden =
        Number(previous.goldenAppleCount ?? 0);

    const nextGolden =
        Number(next.goldenAppleCount ?? 0);

    if (
        previousGolden !==
        nextGolden
    ) {
        addLog(
            state,
            `[INV] Golden Apple ${previousGolden} → ${nextGolden}.`
        );
    }

    const previousTotem =
        Number(previous.totemCount ?? 0);

    const nextTotem =
        Number(next.totemCount ?? 0);

    if (
        previousTotem !==
        nextTotem
    ) {
        addLog(
            state,
            `[TOTEM] Số Totem ${previousTotem} → ${nextTotem}.`
        );
    }

    const previousSelected =
        Number(previous.selectedSlot ?? 0);

    const nextSelected =
        Number(next.selectedSlot ?? 0);

    if (
        previousSelected !==
        nextSelected
    ) {
        addLog(
            state,
            `[HOTBAR] Selected slot ${previousSelected + 1} → ${nextSelected + 1}.`
        );
    }

    const inventoryChanges =
        countSlotChanges(
            previous,
            next,
            9,
            35
        );

    const hotbarChanges =
        countSlotChanges(
            previous,
            next,
            36,
            44
        );

    const equipmentChanges =
        countSlotChanges(
            previous,
            next,
            5,
            8
        );

    const previousOffhand =
        previous?.slotSignatures?.['45'] ||
        'empty';

    const nextOffhand =
        next?.slotSignatures?.['45'] ||
        'empty';

    if (
        inventoryChanges > 0
    ) {
        addLog(
            state,
            `[INV] Inventory cập nhật: ${inventoryChanges} ô thay đổi.`
        );
    }

    if (
        hotbarChanges > 0
    ) {
        addLog(
            state,
            `[HOTBAR] Hotbar cập nhật: ${hotbarChanges} ô thay đổi.`
        );
    }

    if (
        equipmentChanges > 0
    ) {
        addLog(
            state,
            `[EQUIP] Trang bị cập nhật: ${equipmentChanges} ô thay đổi.`
        );
    }

    if (
        previousOffhand !==
        nextOffhand
    ) {
        const oldText =
            previous?.slotSummaries?.['45'] ||
            'empty';

        const newText =
            next?.slotSummaries?.['45'] ||
            'empty';

        addLog(
            state,
            `[EQUIP] Offhand: ${oldText} → ${newText}.`
        );
    }
}

function buildInventorySignature(
    snapshot
) {
    const slotSignatures =
        snapshot.slotSignatures || {};

    const slotParts = [];

    for (
        let slot = 5;
        slot <= 45;
        slot++
    ) {
        slotParts.push(
            `${slot}:${slotSignatures[String(slot)] || 'empty'}`
        );
    }

    return [
        snapshot.selectedSlot,
        slotParts.join(';')
    ].join('|');
}

function scanInventory(
    state,
    bot = state.bot,
    forceLog = false
) {
    if (
        !bot ||
        state.bot !== bot ||
        !bot.inventory ||
        !Array.isArray(bot.inventory.slots)
    ) {
        return false;
    }

    const slots = bot.inventory.slots;
    const offhandSlot = getOffhandSlot(bot);

    const allMainItems = [];

    for (let slot = 9; slot <= 35; slot++) {
        allMainItems.push(
            itemToInventoryData(
                slots[slot] || null,
                slot
            )
        );
    }

    const hotbar = [];

    for (let quickSlot = 0; quickSlot < 9; quickSlot++) {
        const inventorySlot = 36 + quickSlot;
        hotbar.push(
            itemToInventoryData(
                slots[inventorySlot] || null,
                inventorySlot
            )
        );
    }

    const armor = {
        head: itemToInventoryData(slots[5] || null, 5),
        torso: itemToInventoryData(slots[6] || null, 6),
        legs: itemToInventoryData(slots[7] || null, 7),
        feet: itemToInventoryData(slots[8] || null, 8)
    };

    const offhandItem = slots[offhandSlot] || null;

    let foodCount = 0;
    let goldenAppleCount = 0;
    let totemCount = 0;

    for (let slot = 9; slot <= 45; slot++) {
        const item = slots[slot];

        if (!item || !item.name) {
            continue;
        }

        if (FOOD_PRIORITY.includes(item.name)) {
            foodCount += Number(item.count || 0);
        }

        if (item.name === 'golden_apple') {
            goldenAppleCount += Number(item.count || 0);
        }

        if (item.name === 'totem_of_undying') {
            totemCount += Number(item.count || 0);
        }
    }

    const selectedSlot =
        Number.isInteger(bot.quickBarSlot) &&
        bot.quickBarSlot >= 0 &&
        bot.quickBarSlot <= 8
            ? bot.quickBarSlot
            : 0;

    const nextState = {
        revision: state.inventoryRevision,
        health: Number.isFinite(bot.health)
            ? Math.max(0, Math.min(Number(bot.health), 20))
            : 20,
        food: Number.isFinite(bot.food)
            ? Math.max(0, Math.min(Number(bot.food), 20))
            : 20,
        saturation: Number.isFinite(bot.foodSaturation)
            ? Math.max(0, Number(bot.foodSaturation))
            : 20,
        foodCount,
        goldenAppleCount,
        totemCount,
        offhand: offhandItem && offhandItem.name
            ? offhandItem.name
            : null,
        selectedHotbar: selectedSlot,
        selectedSlot,
        armor,
        hotbar,
        inventory: allMainItems,
        slots: buildSlotState(slots)
    };

    const nextSnapshot = buildInventorySnapshot(nextState);
    const previous = state.previousInventorySnapshot;

    const nextSignature = buildInventorySignature(nextSnapshot);
    const previousSignature = previous
        ? buildInventorySignature(previous)
        : '';

    const slotOrSelectionChanged =
        !previous ||
        previousSignature !== nextSignature;

    const displayStateChanged =
        !previous ||
        previous.health !== nextSnapshot.health ||
        previous.food !== nextSnapshot.food ||
        previous.saturation !== nextSnapshot.saturation;

    if (slotOrSelectionChanged) {
        state.inventoryRevision++;
        nextState.revision = state.inventoryRevision;
    } else {
        nextState.revision = state.inventoryRevision;
    }

    state.inventoryState = nextState;

    if (slotOrSelectionChanged || displayStateChanged) {
        logInventoryDifferences(
            state,
            previous,
            nextSnapshot
        );
    } else if (forceLog) {
        addLog(
            state,
            '[INV] Inventory đã đồng bộ.'
        );
    }

    state.inventoryLogSignature = nextSignature;
    state.previousInventorySnapshot = nextSnapshot;

    return true;
}

function findFoodItem(bot) {
    if (
        !bot ||
        !bot.inventory ||
        !Array.isArray(bot.inventory.slots)
    ) {
        return null;
    }

    const slots = bot.inventory.slots;

    for (const foodName of FOOD_PRIORITY) {
        for (let slot = 9; slot <= 44; slot++) {
            const item = slots[slot];

            if (item && item.name === foodName) {
                return item;
            }
        }
    }

    return null;
}

function findTotemItem(bot) {
    if (
        !bot ||
        !bot.inventory ||
        !Array.isArray(bot.inventory.slots)
    ) {
        return null;
    }

    const offhandSlot = getOffhandSlot(bot);

    for (let slot = 9; slot <= 44; slot++) {
        if (slot === offhandSlot) {
            continue;
        }

        const item = bot.inventory.slots[slot];

        if (item && item.name === 'totem_of_undying') {
            return item;
        }
    }

    return null;
}

async function autoEatTick(state) {
    const bot = state.bot;

    if (
        !state.settings.antiHungry ||
        state.manuallyStopped ||
        !bot ||
        state.bot !== bot ||
        !bot.player ||
        !state.ready ||
        state.isEating ||
        state.inventoryActionBusy
    ) {
        return;
    }

    if (
        state.status === 'offline' ||
        state.status === 'connecting' ||
        state.status === 'authenticating' ||
        state.status === 'entering' ||
        state.status === 'kicked'
    ) {
        return;
    }

    if (bot.currentWindow || bot.usingHeldItem) {
        return;
    }

    const health =
        Number.isFinite(bot.health)
            ? Number(bot.health)
            : 20;

    const food =
        Number.isFinite(bot.food)
            ? Number(bot.food)
            : 20;

    // 🚨 Phản xạ sinh tồn: Nếu máu tụt xuống mức nguy hiểm (< 15 HP), ưu tiên ăn Táo Vàng ngay
    let emergencyGapple = null;
    if (health < 15) {
        for (let slot = 9; slot <= 44; slot++) {
            const item = bot.inventory.slots[slot];
            if (item && (item.name === 'golden_apple' || item.name === 'enchanted_golden_apple')) {
                emergencyGapple = item;
                break;
            }
        }
    }

    if (!emergencyGapple && food >= 18) {
        state.foodMissingLogged = false;
        return;
    }

    const foodItem = emergencyGapple || findFoodItem(bot);

    if (!foodItem) {
        if (!state.foodMissingLogged) {
            addLog(
                state,
                '[FOOD] Không tìm thấy thức ăn.'
            );
            state.foodMissingLogged = true;
        }
        return;
    }

    state.foodMissingLogged = false;
    state.isEating = true;
    if (bot) bot.physicsEnabled = true;
    const actionToken = beginInventoryAction(state, bot);

    const oldBot = bot;
    const oldSelectedSlot =
        rememberSelectedSlot(state);

    const foodName =
        foodItem.displayName ||
        foodItem.name;

    const oldHeldItem =
        bot.heldItem ||
        (
            bot.inventory &&
            Array.isArray(bot.inventory.slots)
                ? bot.inventory.slots[36 + oldSelectedSlot] || null
                : null
        );

    try {
        addLog(
            state,
            `[FOOD] Bắt đầu ăn ${foodName}.`
        );

        if (
            !selectHotbarSlot(
                state,
                oldSelectedSlot
            )
        ) {
            return;
        }

        addLog(
            state,
            `[FOOD] Equip ${foodName} vào tay.`
        );

        await withTimeout(
            bot.equip(foodItem, 'hand'),
            INVENTORY_ACTION_TIMEOUT_MS,
            'Equip thức ăn',
            () => invalidateInventoryAction(state)
        );

        if (
            state.manuallyStopped ||
            state.bot !== oldBot ||
            !oldBot.player ||
            oldBot.currentWindow
        ) {
            return;
        }

        addLog(
            state,
            `[FOOD] Bắt đầu Consume ${foodName}.`
        );

        await withTimeout(
            bot.consume(),
            INVENTORY_ACTION_TIMEOUT_MS,
            'Ăn thức ăn',
            () => invalidateInventoryAction(state)
        );

        if (state.bot === oldBot) {
            addLog(
                state,
                `[FOOD] Đã ăn xong ${foodName}.`
            );
        }
    } catch (err) {
        if (state.bot === oldBot) {
            addLog(
                state,
                `[FOOD] Lỗi khi ăn ${foodName}: ${err.message}`
            );
        }
    } finally {
        state.isEating = false;
        setTimeout(() => {
            if (state.bot === oldBot && oldBot) {
                applyEcoModeOptimizations(state, oldBot);
            }
        }, 1500);

        if (
            state.bot !== oldBot ||
            state.manuallyStopped
        ) {
            endInventoryAction(state, oldBot, actionToken);
            return;
        }

        if (!isInventoryActionCurrent(state, oldBot, actionToken)) {
            return;
        }

        try {
            if (
                oldHeldItem &&
                bot.inventory &&
                Array.isArray(bot.inventory.slots) &&
                isInventoryActionCurrent(state, oldBot, actionToken)
            ) {
                let oldItemStillExists = false;

                for (const item of bot.inventory.slots) {
                    if (item === oldHeldItem) {
                        oldItemStillExists = true;
                        break;
                    }
                }

                if (
                    oldItemStillExists &&
                    isInventoryActionCurrent(state, oldBot, actionToken)
                ) {
                    await withTimeout(
                        bot.equip(oldHeldItem, 'hand'),
                        INVENTORY_ACTION_TIMEOUT_MS,
                        'Khôi phục item cũ',
                        () => invalidateInventoryAction(state)
                    );

                    if (isInventoryActionCurrent(state, oldBot, actionToken)) {
                        addLog(
                            state,
                            `[FOOD] Đã khôi phục item cũ: ${oldHeldItem.displayName || oldHeldItem.name}.`
                        );
                    }
                }
            }
        } catch (err) {
            if (state.bot === oldBot) {
                addLog(
                    state,
                    `[HOTBAR] Không thể restore item cũ: ${err.message}`
                );
            }
        }

        if (!isInventoryActionCurrent(state, oldBot, actionToken)) {
            return;
        }

        restoreSelectedSlot(
            state,
            oldSelectedSlot
        );

        if (!isInventoryActionCurrent(state, oldBot, actionToken)) {
            return;
        }

        scanInventory(
            state,
            bot,
            false
        );

        endInventoryAction(state, oldBot, actionToken);
    }
}

async function autoTotemTick(state) {
    const bot = state.bot;

    if (
        !state.settings.autoTotem ||
        state.manuallyStopped ||
        !bot ||
        state.bot !== bot ||
        !bot.player ||
        !bot.entity ||
        !state.ready ||
        state.isEating ||
        state.isEquippingTotem ||
        state.inventoryActionBusy
    ) {
        return;
    }

    if (
        state.status === 'offline' ||
        state.status === 'connecting' ||
        state.status === 'authenticating' ||
        state.status === 'entering' ||
        state.status === 'kicked'
    ) {
        return;
    }

    if (bot.currentWindow || bot.usingHeldItem) {
        return;
    }

    const offhandSlot =
        getOffhandSlot(bot);

    const offhandItem =
        bot.inventory &&
        Array.isArray(bot.inventory.slots)
            ? bot.inventory.slots[offhandSlot]
            : null;

    if (
        offhandItem &&
        offhandItem.name === 'totem_of_undying'
    ) {
        if (state.totemLogState !== 'has') {
            addLog(
                state,
                '[TOTEM] Offhand đã có Totem.'
            );
            state.totemLogState = 'has';
        }
        return;
    }

    if (
        state.totemLogState === 'has'
    ) {
        addLog(
            state,
            '[TOTEM] Totem offhand đã mất hoặc đã được kích hoạt.'
        );
        state.totemLogState = null;
    }

    const totem =
        findTotemItem(bot);

    if (!totem) {
        if (
            state.totemLogState !== 'empty'
        ) {
            addLog(
                state,
                '[TOTEM] Hết Totem.'
            );
            state.totemLogState = 'empty';
        }
        return;
    }

    state.isEquippingTotem = true;
    const actionToken = beginInventoryAction(state, bot);
    state.totemLogState = 'equipping';

    const oldBot = bot;

    try {
        addLog(
            state,
            '[TOTEM] Đang equip Totem vào offhand.'
        );

        await withTimeout(
            bot.equip(totem, 'off-hand'),
            INVENTORY_ACTION_TIMEOUT_MS,
            'Equip Totem',
            () => invalidateInventoryAction(state)
        );

        if (
            state.bot === oldBot &&
            !state.manuallyStopped &&
            isInventoryActionCurrent(state, oldBot, actionToken)
        ) {
            addLog(
                state,
                '[TOTEM] Đã trang bị Totem vào offhand.'
            );

            state.totemLogState = 'has';

            scanInventory(
                state,
                bot,
                false
            );
        }
    } catch (err) {
        if (state.bot === oldBot) {
            addLog(
                state,
                `[TOTEM] Lỗi trang bị Totem: ${err.message}`
            );
            state.totemLogState = null;
        }
    } finally {
        state.isEquippingTotem = false;
        endInventoryAction(state, oldBot, actionToken);
    }
}

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function currentVietnamTimeParts(date = new Date()) {
    const text = date.toLocaleString('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });

    const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2})$/);
    if (!match) {
        return { dateKey: '', timeKey: '' };
    }

    return {
        dateKey: `${match[3]}-${match[2]}-${match[1]}`,
        timeKey: `${match[4]}:${match[5]}`
    };
}

function isAutoChatBotReady(state) {
    return (
        !state.manuallyStopped &&
        state.ready === true &&
        !!state.bot &&
        !!state.bot.player &&
        state.status !== 'offline' &&
        state.status !== 'connecting' &&
        state.status !== 'authenticating' &&
        state.status !== 'entering' &&
        state.status !== 'kicked'
    );
}

async function runAutoChatSchedule(state, schedule) {
    if (
        state.shuttingDown ||
        state.manuallyStopped ||
        schedule.running ||
        !schedule.enabled ||
        !isAutoChatBotReady(state)
    ) {
        return;
    }

    const generation = state.autoChatGeneration;
    schedule.running = true;

    try {
        for (const message of schedule.messages) {
            if (
                state.shuttingDown ||
                state.manuallyStopped ||
                generation !== state.autoChatGeneration ||
                !state.autoChatSchedules.includes(schedule) ||
                !isAutoChatBotReady(state)
            ) {
                break;
            }

            try {
                state.bot.chat(message);
                state.lastWebChatText = cleanMinecraftText(message);
                state.lastWebChatAt = Date.now();
                addChatLog(state, 'AUTO', `→ ${message}`);
                addLog(state, `[AUTOCHAT] Đã gửi: ${message}`);
            } catch (err) {
                addLog(state, `[AUTOCHAT] Gửi lỗi: ${err.message}`);
                break;
            }

            const delay = Number(schedule.messageDelaySeconds || 0) * 1000;
            if (delay > 0) {
                await sleepMs(delay);
            }
        }
    } finally {
        schedule.running = false;
    }
}

async function autoChatTick(state) {
    if (state.shuttingDown || state.manuallyStopped || !isAutoChatBotReady(state)) {
        return;
    }

    const now = Date.now();
    const timeParts = currentVietnamTimeParts(new Date(now));

    for (const schedule of state.autoChatSchedules) {
        if (!schedule.enabled || !schedule.messages.length || schedule.running) {
            continue;
        }

        if (schedule.mode === 'fixed') {
            for (const timeKey of schedule.times) {
                const currentKey = `${timeParts.dateKey} ${timeKey}`;
                if (
                    timeParts.timeKey === timeKey &&
                    schedule.lastFixedRunKey !== currentKey
                ) {
                    schedule.lastFixedRunKey = currentKey;
                    void runAutoChatSchedule(state, schedule);
                    break;
                }
            }
        } else {
            if (
                !schedule.lastIntervalRunAt ||
                now - schedule.lastIntervalRunAt >= Number(schedule.intervalSeconds || 3600) * 1000
            ) {
                schedule.lastIntervalRunAt = now;
                void runAutoChatSchedule(state, schedule);
            }
        }
    }
}

function getBotCycleEventIndex(schedule, now = Date.now()) {
    if (!schedule || schedule.mode !== 'cycle' || !Array.isArray(schedule.items) || !schedule.items.length) {
        return 0;
    }

    const anchorAt = Number(schedule.cycleAnchorAt);
    if (!Number.isFinite(anchorAt) || anchorAt <= 0) return 0;

    const durations = schedule.items.map(item => Math.max(1, Number(item.afterMinutes || 0)) * 60);
    if (!durations.length || durations.some(value => !Number.isFinite(value) || value <= 0)) return 0;

    const cycleLength = durations.reduce((sum, value) => sum + value, 0);
    const elapsedSeconds = Math.max(0, (Number(now) - anchorAt) / 1000);
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < durations[0]) return 0;

    const itemCount = durations.length;
    const cycleNumber = Math.floor(elapsedSeconds / cycleLength);
    const cycleOffset = elapsedSeconds - cycleNumber * cycleLength;

    let completedInCycle = 0;
    let cumulative = 0;
    for (const duration of durations) {
        cumulative += duration;
        if (cycleOffset + 0.001 >= cumulative) completedInCycle++;
        else break;
    }

    return cycleNumber * itemCount + completedInCycle;
}

function getBotCycleEventAction(schedule, eventIndex) {
    if (!schedule || !Array.isArray(schedule.items) || !Number.isInteger(eventIndex) || eventIndex <= 0) return null;
    const itemIndex = (eventIndex - 1) % schedule.items.length;
    const item = schedule.items[itemIndex];
    return item && item.action === 'start' ? 'start' : 'stop';
}

function markManualLifecycleAction(state) {
    state.lastManualLifecycleAt = Date.now();
}

function applyScheduledLifecycleAction(state, action, reason) {
    if (
        state.shuttingDown ||
        state.lifecycleActionBusy ||
        Date.now() - Number(state.lastManualLifecycleAt || 0) < BOT_SCHEDULER_MANUAL_GUARD_MS
    ) {
        return false;
    }

    if (
        action === 'start' &&
        !state.manuallyStopped &&
        (state.bot || ['connecting', 'authenticating', 'entering', 'online', 'afk'].includes(state.status))
    ) {
        addLog(state, `[SCHEDULER] ${reason}: Bot đã ở trạng thái chạy, bỏ qua START.`);
        return true;
    }

    if (action === 'stop' && state.manuallyStopped && !state.bot) {
        addLog(state, `[SCHEDULER] ${reason}: Bot đã tắt, bỏ qua STOP.`);
        return true;
    }

    state.lifecycleActionBusy = true;
    try {
        if (action === 'stop') {
            stopBot(state, 'scheduler');
        } else if (action === 'start') {
            if (!startBot(state, 'scheduler')) {
                addLog(state, `[SCHEDULER] ${reason}: Bỏ qua START vì thiếu username hoặc password.`);
                return true;
            }
        } else {
            return false;
        }

        addLog(state, `[SCHEDULER] ${reason}: ${action === 'stop' ? 'Tắt bot' : 'Bật bot'}.`);
        return true;
    } finally {
        state.lifecycleActionBusy = false;
    }
}

function persistBotSchedulerRuntimeState(state) {
    const saved = saveBotSettingsFile(state.settings, state.autoChatSchedules, state.botSchedules);
    if (!saved) addLog(state, '[SCHEDULER] Không thể lưu trạng thái tiến độ lịch vào bot_settings.json.');
    return saved;
}

function botSchedulerTick(state) {
    if (state.shuttingDown) return;

    const now = Date.now();
    const timeParts = currentVietnamTimeParts(new Date(now));
    const manualGuardActive =
        now - Number(state.lastManualLifecycleAt || 0) < BOT_SCHEDULER_MANUAL_GUARD_MS;

    for (const schedule of state.botSchedules) {
        if (!schedule.enabled || !Array.isArray(schedule.items) || !schedule.items.length) continue;

        if (schedule.mode === 'fixed') {
            for (const item of schedule.items) {
                if (item.time !== timeParts.timeKey) continue;
                const currentKey = `${timeParts.dateKey} ${item.time}`;
                if (item.lastFixedRunKey === currentKey) continue;

                if (manualGuardActive) {
                    // Manual START/STOP has priority. Consume this occurrence so
                    // the scheduler cannot execute it a few seconds later after
                    // the guard expires. The next occurrence will run normally.
                    item.lastFixedRunKey = currentKey;
                    addLog(
                        state,
                        `[SCHEDULER] Cố định ${item.time}: bỏ qua lần này vì vừa có thao tác START/STOP thủ công.`
                    );
                    persistBotSchedulerRuntimeState(state);
                    break;
                }

                const applied = applyScheduledLifecycleAction(state, item.action, `Cố định ${item.time}`);
                if (applied) {
                    item.lastFixedRunKey = currentKey;
                    persistBotSchedulerRuntimeState(state);
                    break;
                }
            }
            continue;
        }

        const eventIndex = getBotCycleEventIndex(schedule, now);
        if (eventIndex <= Number(schedule.lastCycleEventIndex || 0)) continue;

        const action = getBotCycleEventAction(schedule, eventIndex);
        if (!action) continue;

        if (manualGuardActive) {
            schedule.lastCycleEventIndex = eventIndex;
            addLog(
                state,
                `[SCHEDULER] Chu kỳ #${eventIndex}: bỏ qua lần này vì vừa có thao tác START/STOP thủ công.`
            );
            persistBotSchedulerRuntimeState(state);
            continue;
        }

        const applied = applyScheduledLifecycleAction(state, action, `Chu kỳ #${eventIndex}`);
        if (applied) {
            schedule.lastCycleEventIndex = eventIndex;
            persistBotSchedulerRuntimeState(state);
        }
    }
}

function startBotScheduler(state) {
    if (state.botSchedulerTimer) {
        clearInterval(state.botSchedulerTimer);
    }

    state.botSchedulerTimer = setInterval(
        () => botSchedulerTick(state),
        BOT_SCHEDULER_TICK_MS
    );
}

function clearBotSchedulerTimer(state) {
    if (state.botSchedulerTimer) {
        clearInterval(state.botSchedulerTimer);
        state.botSchedulerTimer = null;
    }
}


function startBackgroundManagers(state, bot) {
    clearManagerTimers(state);

    scanInventory(
        state,
        bot,
        true
    );

    state.inventoryScanTimer =
        setInterval(
            () => {
                if (
                    state.manuallyStopped ||
                    state.bot !== bot
                ) {
                    return;
                }

                scanInventory(
                    state,
                    bot,
                    false
                );
            },
            INVENTORY_SCAN_INTERVAL_MS
        );

    state.eatTimer =
        setInterval(
            () => {
                if (
                    state.manuallyStopped ||
                    state.bot !== bot
                ) {
                    return;
                }

                autoEatTick(state)
                    .catch(err => {
                        if (state.bot === bot) {
                            addLog(
                                state,
                                `[FOOD] Lỗi manager: ${err.message}`
                            );
                        }
                    });
            },
            AUTO_EAT_INTERVAL_MS
        );

    state.totemTimer =
        setInterval(
            () => {
                if (
                    state.manuallyStopped ||
                    state.bot !== bot
                ) {
                    return;
                }

                autoTotemTick(state)
                    .catch(err => {
                        if (state.bot === bot) {
                            addLog(
                                state,
                                `[TOTEM] Lỗi manager: ${err.message}`
                            );
                        }
                    });
            },
            AUTO_TOTEM_INTERVAL_MS
        );

    state.autoChatTimer =
        setInterval(
            () => {
                if (
                    state.manuallyStopped ||
                    state.bot !== bot
                ) {
                    return;
                }

                autoChatTick(state)
                    .catch(err => {
                        if (state.bot === bot) {
                            addLog(
                                state,
                                `[AUTOCHAT] Lỗi manager: ${err.message}`
                            );
                        }
                    });
            },
            1000
        );
}

function publicInventoryState(state) {
    const inventory = state.inventoryState || {};

    return {
        revision:
            Number(inventory.revision ?? state.inventoryRevision ?? 0),

        health:
            Number(inventory.health ?? 20),

        food:
            Number(inventory.food ?? 20),

        saturation:
            Number(inventory.saturation ?? 20),

        foodCount:
            Number(inventory.foodCount ?? 0),

        goldenAppleCount:
            Number(inventory.goldenAppleCount ?? 0),

        totemCount:
            Number(inventory.totemCount ?? 0),

        offhand:
            inventory.offhand ?? null,

        selectedHotbar:
            Number(inventory.selectedHotbar ?? 0),

        selectedSlot:
            Number(inventory.selectedSlot ?? 0),

        armor:
            inventory.armor || {
                head: null,
                torso: null,
                legs: null,
                feet: null
            },

        hotbar:
            Array.isArray(inventory.hotbar)
                ? inventory.hotbar
                : [],

        inventory:
            Array.isArray(inventory.inventory)
                ? inventory.inventory
                : [],

        slots:
            inventory.slots || {}
    };
}

function currentHost(state) {
    return (
        HOSTS[state.hostIndex] ||
        HOSTS[0] ||
        'sgp.kingmc.vn'
    );
}

function getPing(state) {
    if (!state.bot) return null;

    if (
        state.bot.player &&
        Number.isFinite(state.bot.player.ping)
    ) {
        return state.bot.player.ping;
    }

    if (
        state.bot._client &&
        Number.isFinite(state.bot._client.latency)
    ) {
        return state.bot._client.latency;
    }

    return null;
}

function updateAfkUptime(state) {
    if (
        state.afkStartedAt &&
        state.status === 'afk'
    ) {
        state.afkElapsedSeconds +=
            Math.floor(
                (Date.now() - state.afkStartedAt) / 1000
            );

        state.afkStartedAt =
            Date.now();
    }
}

function setBotStatus(state, status) {
    if (
        state.status === 'afk' &&
        status !== 'afk'
    ) {
        updateAfkUptime(state);
        state.afkStartedAt = null;
    }

    if (
        status === 'afk' &&
        state.status !== 'afk'
    ) {
        state.afkStartedAt = Date.now();
    }

    if (state.status !== status) {
        state.status = status;
        state.stateRevision++;
    }
}

function getUptimeSeconds(state) {
    let total =
        state.afkElapsedSeconds || 0;

    if (
        state.status === 'afk' &&
        state.afkStartedAt
    ) {
        total +=
            Math.floor(
                (Date.now() - state.afkStartedAt) / 1000
            );
    }

    return Math.min(
        Math.max(total, 0),
        (999 * 60 * 60) - 1
    );
}

function formatUptime(state) {
    const totalSeconds =
        getUptimeSeconds(state);

    const hours =
        Math.floor(
            totalSeconds / 3600
        );

    const minutes =
        Math.floor(
            (totalSeconds % 3600) / 60
        );

    const seconds =
        totalSeconds % 60;

    return (
        `${hours}h ` +
        `${minutes}m ` +
        `${seconds}s`
    );
}

function getRoundedBotCoordinates(bot) {
    if (!bot || !bot.entity || !bot.entity.position) {
        return null;
    }

    const x = Number(bot.entity.position.x);
    const y = Number(bot.entity.position.y);
    const z = Number(bot.entity.position.z);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return null;
    }

    return {
        x: Math.round(x),
        y: Math.round(y),
        z: Math.round(z)
    };
}

function sameCoordinates(a, b) {
    return !!a && !!b &&
        a.x === b.x &&
        a.y === b.y &&
        a.z === b.z;
}

function getBotBlockCoordinates(bot) {
    if (!bot || !bot.entity || !bot.entity.position) {
        return null;
    }

    const x = Number(bot.entity.position.x);
    const y = Number(bot.entity.position.y);
    const z = Number(bot.entity.position.z);

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return null;
    }

    return {
        x: Math.floor(x),
        y: Math.floor(y),
        z: Math.floor(z)
    };
}

function getLocationKind(bot) {
    // Location flow intentionally uses rounded player coordinates.
    // The dashboard also displays rounded coordinates, and the previous
    // working bot used the same rule. Using Math.floor here can classify
    // an actual AUTH/LOBBY position as "other" when the player Y/X/Z has
    // a fractional component near the block boundary.
    const coordinates = getRoundedBotCoordinates(bot);

    if (!coordinates) {
        return 'unknown';
    }

    if (sameCoordinates(coordinates, AUTH_COORDS)) {
        return 'login';
    }

    if (sameCoordinates(coordinates, LOBBY_COORDS)) {
        return 'lobby';
    }

    return 'other';
}

function getLocationRetryDelay(state) {
    const attempt = Math.max(Number(state.locationRetryAttempt || 1), 1);
    return Math.min(
        Math.round(LOCATION_RETRY_BASE_MS * Math.pow(1.7, attempt - 1)),
        LOCATION_RETRY_MAX_MS
    );
}

function scheduleLocationRetry(state, bot, reason, preserveAfkConfirmation = false) {
    if (
        state.shuttingDown ||
        state.manuallyStopped ||
        state.bot !== bot
    ) {
        return;
    }

    if (!state.settings.autoReconnect) {
        state.locationRetryTimer = null;
        state.locationFlowBusy = false;
        state.pendingAfkConfirmation = false;
        state.ready = false;
        return;
    }

    if (state.locationRetryTimer) {
        return;
    }

    state.locationRetryAttempt++;
    state.locationRetryReason = reason;
    state.ready = false;
    state.locationFlowBusy = true;

    if (!preserveAfkConfirmation) {
        state.pendingAfkConfirmation = false;
    }

    const delay = getLocationRetryDelay(state);

    if (reason === 'login') {
        setBotStatus(state, 'authenticating');
    } else {
        setBotStatus(state, 'entering');
    }

    addLog(
        state,
        `[FLOW] Thử lại ${reason} lần #${state.locationRetryAttempt} sau ${delay / 1000}s.`
    );

    state.locationRetryTimer = setTimeout(() => {
        state.locationRetryTimer = null;

        if (
            state.shuttingDown ||
            state.manuallyStopped ||
            state.bot !== bot
        ) {
            return;
        }

        if (preserveAfkConfirmation) {
            const kind = getLocationKind(bot);

            if (kind === 'other') {
                state.pendingAfkConfirmation = true;
                state.locationFlowBusy = true;

                if (!state.locationConfirmTimer) {
                    state.locationConfirmTimer = setTimeout(() => {
                        state.locationConfirmTimer = null;
                        confirmAfkAfterClick(state, bot);
                    }, AFK_CONFIRM_DELAY_MS);
                }
                return;
            }

            if (reason === 'menu-confirm' && kind === 'lobby') {
                state.pendingAfkConfirmation = true;
                state.locationFlowBusy = true;
                startAfkRoutine(state, bot);
                return;
            }

            state.pendingAfkConfirmation = false;
        }

        state.locationFlowBusy = false;
    }, delay);
}

function confirmAfkAfterClick(state, bot) {
    if (
        state.shuttingDown ||
        state.manuallyStopped ||
        state.bot !== bot ||
        !state.pendingAfkConfirmation
    ) {
        return;
    }

    const kind = getLocationKind(bot);
    state.locationState = kind;

    if (kind === 'other') {
        state.pendingAfkConfirmation = false;
        state.locationFlowBusy = false;
        state.ready = true;
        state.locationRetryAttempt = 0;
        state.locationRetryReason = '';
        state.menuCommandIndex = 0;
        state.loginFlowStartedAt = null;
        setBotStatus(state, 'afk');

        addLog(state, '[FLOW] Xác nhận tọa độ sau click: đã rời LOGIN/LOBBY.');
        addLog(state, '✅ Đã xác nhận trạng thái AFK.');

        // Ghi log tọa độ sinh tồn thực tế (LOẠI BỎ hoàn toàn tọa độ sảnh & login theo yêu cầu người dùng)
        const coords = getRoundedBotCoordinates(bot);
        if (coords && !sameCoordinates(coords, AUTH_COORDS) && !sameCoordinates(coords, LOBBY_COORDS)) {
            if (typeof botSupabase !== 'undefined' && botSupabase && botSupabase.isEnabled()) {
                void botSupabase.logBotAction({
                    action: 'BOT_POSITION_UPDATE',
                    actionLabel: '📍 Tọa độ Bot sinh tồn',
                    category: 'BOT_COORDS',
                    details: `Tọa độ bot vào thế giới sinh tồn: X=${coords.x}, Y=${coords.y}, Z=${coords.z} (Thế giới: ${getBotDimension(state) || 'overworld'})`,
                    status: 'SUCCESS'
                });
            }
        }

        // Kích hoạt Anti-AFK Kick & Tối ưu Farm
        startSmartAntiAfk(state);
        applyHighDensityFarmOptimizations(state, bot);
        runSpawnCommands(state, bot);
        return;
    }

    state.ready = false;

    if (kind === 'login') {
        state.pendingAfkConfirmation = false;
        state.locationFlowBusy = false;
        setBotStatus(state, 'authenticating');
        scheduleLocationRetry(state, bot, 'login');
        return;
    }

    if (kind === 'lobby') {
        setBotStatus(state, 'entering');
        scheduleLocationRetry(state, bot, 'menu-confirm', true);
        return;
    }

    scheduleLocationRetry(state, bot, 'coordinate', true);
}

function resetLocationFlowState(state, reason = '') {
    if (state.locationRetryTimer) {
        clearTimeout(state.locationRetryTimer);
        state.locationRetryTimer = null;
    }

    if (state.locationConfirmTimer) {
        clearTimeout(state.locationConfirmTimer);
        state.locationConfirmTimer = null;
    }

    state.locationActionBusy = false;
    state.locationFlowBusy = false;
    state.pendingAfkConfirmation = false;
    state.locationRetryAttempt = 0;
    state.locationRetryReason = '';

    if (reason) {
        addLog(state, `[FLOW] Reset flow: ${reason}.`);
    }
}

function startLocationMonitor(state, bot) {
    clearLocationTimers(state);
    state.locationState = 'unknown';

    const tick = () => {
        if (
            state.shuttingDown ||
            state.manuallyStopped ||
            state.bot !== bot ||
            !bot.entity
        ) {
            return;
        }

        const previousKind = state.locationState;
        const kind = getLocationKind(bot);
        state.locationState = kind;
        const now = Date.now();

        // The server can silently return an already-connected AFK bot to the
        // auth/lobby coordinates without closing the Mineflayer connection.
        // Treat that as a fresh flow instead of relying on the old AFK state.
        if (
            state.status === 'afk' &&
            previousKind === 'other' &&
            (kind === 'login' || kind === 'lobby')
        ) {
            state.ready = false;
            resetLocationFlowState(
                state,
                `phát hiện AFK -> ${kind.toUpperCase()} bất ngờ`
            );
            setBotStatus(
                state,
                kind === 'login' ? 'authenticating' : 'entering'
            );
        }

        // If the bot has already left LOGIN/LOBBY, treat that
        // coordinate change as the AFK success condition immediately.
        // This must run before the generic flow-busy guards because an
        // entering flow can still have locationFlowBusy=true when the server
        // teleports the bot out of the lobby.
        if (
            previousKind === 'lobby' &&
            kind === 'other' &&
            state.status === 'entering' &&
            !state.manuallyStopped
        ) {
            state.ready = false;
            state.locationFlowBusy = true;
            state.pendingAfkConfirmation = true;

            addLog(
                state,
                '[FLOW] Phát hiện bot đã rời LOBBY → chờ xác nhận AFK.'
            );

            if (!state.locationConfirmTimer) {
                state.locationConfirmTimer = setTimeout(() => {
                    state.locationConfirmTimer = null;
                    confirmAfkAfterClick(state, bot);
                }, AFK_CONFIRM_DELAY_MS);
            }
        }

        // Self-heal a flow that got stuck because a GUI/teleport changed
        // state between two timers. Without this guard, locationFlowBusy can
        // remain true forever and block all subsequent /login or /dn actions.
        if (
            state.locationFlowBusy &&
            !state.locationRetryTimer &&
            !state.locationActionBusy &&
            !state.pendingAfkConfirmation &&
            (kind === 'login' || kind === 'lobby')
        ) {
            const lastActionAt =
                kind === 'login'
                    ? Number(state.lastLoginActionAt || 0)
                    : Number(state.lastDnActionAt || 0);

            if (
                lastActionAt > 0 &&
                now - lastActionAt >= 7000
            ) {
                resetLocationFlowState(
                    state,
                    `flow ${kind.toUpperCase()} bị kẹt quá 7 giây`
                );
            }
        }

        // When the AFK confirmation timer is active, let it decide the
        // final state from the current coordinates.
        if (state.pendingAfkConfirmation && kind !== 'unknown') {
            if (!state.locationConfirmTimer) {
                state.locationConfirmTimer = setTimeout(() => {
                    state.locationConfirmTimer = null;
                    confirmAfkAfterClick(state, bot);
                }, AFK_CONFIRM_DELAY_MS);
            }
            return;
        }

        if (state.locationRetryTimer || state.locationActionBusy) {
            return;
        }

        if (state.locationFlowBusy || state.pendingAfkConfirmation) {
            return;
        }

        if (kind === 'login') {
            if (state.status === 'afk') {
                state.ready = false;
                setBotStatus(state, 'authenticating');
            }

            const now = Date.now();
            if (
                state.password &&
                now - state.lastLoginActionAt >= LOCATION_ACTION_COOLDOWN_MS
            ) {
                state.lastLoginActionAt = now;
                state.locationActionBusy = true;
                state.locationFlowBusy = true;
                state.ready = false;
                setBotStatus(state, 'authenticating');

                try {
                    bot.chat(`/login ${state.password}`);
                    addLog(state, '[FLOW] Tọa độ LOGIN xác nhận → gửi /login.');
                } catch (err) {
                    addLog(state, `[FLOW] /login lỗi: ${err.message}`);
                } finally {
                    state.locationActionBusy = false;
                }

                const verifyTimer = setTimeout(() => {
                    if (state.bot !== bot || state.manuallyStopped) return;

                    const verifyKind = getLocationKind(bot);

                    if (verifyKind === 'login') {
                        // Some KingMC auth flows keep the player at AUTH_COORDS
                        // after /login succeeds. In that case the old flow could
                        // still progress because the server accepted /dn from
                        // the auth location. Send /dn once as a fallback, then
                        // let the normal location monitor continue the flow.
                        const nowAfterLogin = Date.now();
                        if (
                            state.password &&
                            nowAfterLogin - Number(state.lastAuthDnActionAt || 0) >= 3000
                        ) {
                            state.lastAuthDnActionAt = nowAfterLogin;
                            state.lastDnActionAt = nowAfterLogin;
                            state.locationFlowBusy = true;
                            state.ready = false;
                            setBotStatus(state, 'entering');

                            try {
                                bot.chat(`/dn ${state.password}`);
                                addLog(
                                    state,
                                    '[FLOW] Vẫn ở tọa độ AUTH sau /login → gửi /dn trực tiếp.'
                                );
                            } catch (err) {
                                state.locationFlowBusy = false;
                                addLog(
                                    state,
                                    `[FLOW] /dn tại AUTH lỗi: ${err.message}`
                                );
                                scheduleLocationRetry(state, bot, 'login');
                                return;
                            }

                            const authDnVerifyTimer = setTimeout(() => {
                                if (state.bot !== bot || state.manuallyStopped) return;

                                if (getLocationKind(bot) === 'login') {
                                    state.locationFlowBusy = false;
                                    scheduleLocationRetry(state, bot, 'login');
                                } else {
                                    state.locationFlowBusy = false;
                                    state.locationRetryAttempt = 0;
                                }
                            }, 1500);

                            state.afkTimers.push(authDnVerifyTimer);
                            return;
                        }

                        state.locationFlowBusy = false;
                        scheduleLocationRetry(state, bot, 'login');
                    } else {
                        state.locationFlowBusy = false;
                        state.locationRetryAttempt = 0;
                    }
                }, 1200);
                state.afkTimers.push(verifyTimer);
            }

            return;
        }

        if (kind === 'lobby') {
            if (state.status === 'afk') {
                state.ready = false;
                setBotStatus(state, 'entering');
            }

            if (!state.password) {
                return;
            }

            if (state.locationFlowBusy || state.pendingAfkConfirmation) {
                return;
            }

            const now = Date.now();
            if (
                now - state.lastDnActionAt >= LOCATION_ACTION_COOLDOWN_MS
            ) {
                state.lastDnActionAt = now;
                state.locationFlowBusy = true;
                state.ready = false;
                setBotStatus(state, 'entering');

                try {
                    bot.chat(`/dn ${state.password}`);
                    addLog(state, '[FLOW] Tọa độ LOBBY xác nhận → gửi /dn.');
                } catch (err) {
                    state.locationFlowBusy = false;
                    addLog(state, `[FLOW] /dn lỗi: ${err.message}`);
                    scheduleLocationRetry(state, bot, 'lobby');
                    return;
                }

                const timer = setTimeout(() => {
                    if (
                        state.bot === bot &&
                        !state.manuallyStopped &&
                        getLocationKind(bot) === 'lobby'
                    ) {
                        startAfkRoutine(state, bot);
                    } else {
                        state.locationFlowBusy = false;
                    }
                }, DN_TO_AFK_DELAY);

                state.afkTimers.push(timer);
            }

            return;
        }

        if (state.status === 'afk' && state.ready) {
            return;
        }

        if (!state.pendingAfkConfirmation && state.status === 'authenticating') {
            state.ready = false;
        }
    };

    tick();

    state.locationMonitorTimer = setInterval(
        tick,
        COORD_SCAN_INTERVAL_MS
    );
}

async function refreshPublicIp(state) {
    let controller = null;
    let timer = null;
    try {
        controller = new AbortController();
        timer = setTimeout(() => controller.abort(), 10000);
        const response = await fetch('https://api.ipify.org?format=json', {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const ip = String(data?.ip || '').trim();

        if (ip) {
            state.publicIp = ip;
            state.publicIpUpdatedAt = Date.now();
        }
    } catch (err) {
        const message = err?.name === 'AbortError' ? 'Timeout khi lấy IP public.' : (err?.message || 'Lỗi không xác định.');
        addLog(state, `[IP] Không lấy được IP public: ${message}`);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function startPublicIpMonitor(state) {
    if (state.publicIpTimer) {
        clearInterval(state.publicIpTimer);
    }

    void refreshPublicIp(state);
    state.publicIpTimer = setInterval(
        () => void refreshPublicIp(state),
        IP_REFRESH_INTERVAL_MS
    );
}

function getBotPosition(state) {
    if (
        !state.bot ||
        !state.bot.entity ||
        !state.bot.entity.position
    ) {
        return null;
    }

    const position =
        state.bot.entity.position;

    const x = Number(position.x);
    const y = Number(position.y);
    const z = Number(position.z);

    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z)
    ) {
        return null;
    }

    return {
        x: Math.round(x),
        y: Math.round(y),
        z: Math.round(z)
    };
}

function getBotDimension(state) {
    if (!state.bot) {
        return null;
    }

    if (
        typeof state.bot.game?.dimension ===
        'string'
    ) {
        return state.bot.game.dimension;
    }

    return null;
}

// -----------------------------------------------------------------------------
// Real-time Host Hardware & Network Telemetry Engine (Render Container & Multi-tier Network)
// -----------------------------------------------------------------------------

function readCgroupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8').trim();
            return content;
        }
    } catch (_) {}
    return null;
}

function getContainerMemoryLimit() {
    // a1) Pterodactyl / Wisp panel container limit in MB (Deplexo, WispByte)
    if (process.env.SERVER_MEMORY) {
        const sm = Number(process.env.SERVER_MEMORY);
        if (Number.isFinite(sm) && sm > 0) return Math.round(sm);
    }

    // a2) Render container environment limit
    if (process.env.RENDER || process.env.RENDER_SERVICE_ID) {
        return Number(process.env.RENDER_MEMORY_MB) || 512;
    }

    // b) process.constrainedMemory() (Node 19.6+)
    if (typeof process.constrainedMemory === 'function') {
        try {
            const cm = process.constrainedMemory();
            if (cm > 0 && cm < os.totalmem()) {
                return Math.round(cm / (1024 * 1024));
            }
        } catch (_) {}
    }

    // c) Cgroups v2 & v1
    const oneTbBytes = 1024 * 1024 * 1024 * 1024;
    const v2Max = readCgroupFile('/sys/fs/cgroup/memory.max');
    if (v2Max && v2Max !== 'max') {
        const val = Number(v2Max);
        if (val > 0 && val < oneTbBytes) return Math.round(val / (1024 * 1024));
    }
    const v1Limit = readCgroupFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    if (v1Limit && v1Limit !== 'max') {
        const val = Number(v1Limit);
        if (val > 0 && val < oneTbBytes) return Math.round(val / (1024 * 1024));
    }

    // d) Fallback os.totalmem()
    return Math.round(os.totalmem() / (1024 * 1024));
}

function getContainerMemoryUsage(totalMb) {
    const v2Cur = readCgroupFile('/sys/fs/cgroup/memory.current');
    if (v2Cur) {
        const valMb = Math.round(Number(v2Cur) / (1024 * 1024));
        if (valMb > 0 && valMb <= totalMb) return valMb;
    }
    const v1Usage = readCgroupFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    if (v1Usage) {
        const valMb = Math.round(Number(v1Usage) / (1024 * 1024));
        if (valMb > 0 && valMb <= totalMb) return valMb;
    }
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    return Math.min(totalMb, rssMb);
}

function getContainerCpuCores() {
    const v2CpuMax = readCgroupFile('/sys/fs/cgroup/cpu.max');
    if (v2CpuMax) {
        const parts = v2CpuMax.split(/\s+/);
        if (parts.length >= 2 && parts[0] !== 'max') {
            const quota = Number(parts[0]);
            const period = Number(parts[1]);
            if (quota > 0 && period > 0) {
                return Math.max(0.5, Math.round((quota / period) * 10) / 10);
            }
        }
    }
    const v1Quota = readCgroupFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
    const v1Period = readCgroupFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    if (v1Quota && v1Period && Number(v1Quota) > 0) {
        const quota = Number(v1Quota);
        const period = Number(v1Period);
        if (quota > 0 && period > 0) {
            return Math.max(0.5, Math.round((quota / period) * 10) / 10);
        }
    }
    const pterCpu = Number(process.env.SERVER_CPU);
    if (pterCpu > 0) {
        return Math.max(0.5, Math.round((pterCpu / 100) * 10) / 10);
    }
    try {
        const cpus = os.cpus();
        if (Array.isArray(cpus) && cpus.length > 0) return cpus.length;
    } catch (_) {}
    return 1;
}

function readProcNetDev() {
    try {
        const raw = readCgroupFile('/proc/net/dev');
        if (!raw) return null;
        let rxTotal = 0;
        let txTotal = 0;
        const lines = raw.split('\n');
        for (const line of lines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const iface = line.slice(0, colonIdx).trim();
            if (iface === 'lo') continue;
            const parts = line.slice(colonIdx + 1).trim().split(/\s+/);
            if (parts.length >= 9) {
                const rx = Number(parts[0]) || 0;
                const tx = Number(parts[8]) || 0;
                rxTotal += rx;
                txTotal += tx;
            }
        }
        if (rxTotal > 0 || txTotal > 0) {
            return { rxBytes: rxTotal, txBytes: txTotal };
        }
    } catch (_) {}
    return null;
}

// Bộ lấy mẫu CPU định kỳ bằng process.cpuUsage() & elapsed time
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();
let currentHostCpuPercent = 0;
let hostCpuCores = getContainerCpuCores();

setInterval(() => {
    try {
        const now = Date.now();
        const elapsedMs = now - lastCpuTime;
        if (elapsedMs <= 0) return;

        hostCpuCores = getContainerCpuCores();
        const diff = process.cpuUsage(lastCpuUsage);
        lastCpuUsage = process.cpuUsage();
        lastCpuTime = now;

        const totalMicros = diff.user + diff.system;
        const elapsedMicros = elapsedMs * 1000;
        const percent = (totalMicros / (elapsedMicros * hostCpuCores)) * 100;
        currentHostCpuPercent = Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
    } catch (_) {}
}, 2000);

// Bộ đo lưu lượng mạng đa tầng (Tầng 1: /proc/net/dev | Tầng 2: Socket MC + Express HTTP)
let cumulativeMcRxBytes = 0;
let cumulativeMcTxBytes = 0;
let lastKnownSocket = null;
let lastSocketRx = 0;
let lastSocketTx = 0;

let lastNetSampleTime = Date.now();
let lastNetRxBytes = 0;
let lastNetTxBytes = 0;
let currentNetDownKbps = 0;
let currentNetUpKbps = 0;
let totalNetRxMb = 0;
let totalNetTxMb = 0;

setInterval(() => {
    try {
        const now = Date.now();
        const elapsedSec = (now - lastNetSampleTime) / 1000;
        if (elapsedSec <= 0) return;

        // Cập nhật socket Minecraft (Tầng 2)
        const sock = botState.bot?._client?.socket;
        if (sock && !sock.destroyed) {
            const curSockRx = Number(sock.bytesRead || 0);
            const curSockTx = Number(sock.bytesWritten || 0);
            if (lastKnownSocket === sock) {
                if (curSockRx >= lastSocketRx) cumulativeMcRxBytes += (curSockRx - lastSocketRx);
                if (curSockTx >= lastSocketTx) cumulativeMcTxBytes += (curSockTx - lastSocketTx);
            } else {
                lastKnownSocket = sock;
                cumulativeMcRxBytes += curSockRx;
                cumulativeMcTxBytes += curSockTx;
            }
            lastSocketRx = curSockRx;
            lastSocketTx = curSockTx;
        }

        // Tầng 1: Đọc /proc/net/dev
        const procNet = readProcNetDev();
        let curRx = 0;
        let curTx = 0;

        if (procNet) {
            curRx = procNet.rxBytes;
            curTx = procNet.txBytes;
        } else {
            // Tầng 2: Fallback qua socket Minecraft + Express HTTP
            curRx = cumulativeMcRxBytes + cumulativeHttpRxBytes;
            curTx = cumulativeMcTxBytes + cumulativeHttpTxBytes;
        }

        if (lastNetRxBytes > 0 && curRx >= lastNetRxBytes) {
            currentNetDownKbps = Math.round(((curRx - lastNetRxBytes) / 1024) / elapsedSec * 10) / 10;
        } else {
            currentNetDownKbps = 0;
        }

        if (lastNetTxBytes > 0 && curTx >= lastNetTxBytes) {
            currentNetUpKbps = Math.round(((curTx - lastNetTxBytes) / 1024) / elapsedSec * 10) / 10;
        } else {
            currentNetUpKbps = 0;
        }

        lastNetRxBytes = curRx;
        lastNetTxBytes = curTx;
        totalNetRxMb = Math.round((curRx / (1024 * 1024)) * 10) / 10;
        totalNetTxMb = Math.round((curTx / (1024 * 1024)) * 10) / 10;
        lastNetSampleTime = now;
    } catch (_) {}
}, 2000);

function getHostHardware() {
    try {
        const ramTotalMb = getContainerMemoryLimit();
        const ramUsedMb = getContainerMemoryUsage(ramTotalMb);
        const ramPercent = ramTotalMb > 0 ? Math.round((ramUsedMb / ramTotalMb) * 1000) / 10 : 0;
        const mem = process.memoryUsage();
        const botRssMb = Math.round(mem.rss / (1024 * 1024));
        const botHeapMb = Math.round(mem.heapUsed / (1024 * 1024));
        const botHeapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));

        return {
            ramPercent,          // % RAM máy host/container đã dùng
            ramUsedMb,           // MB RAM máy host/container đã dùng
            ramTotalMb,          // Tổng MB RAM được cấp
            botRssMb,            // RAM riêng của bot (MB RSS)
            botHeapMb,           // RAM Heap thực tế bot đang dùng (MB)
            botHeapTotalMb,      // Tổng Heap được cấp (MB)
            cpuPercent: currentHostCpuPercent, // % CPU thực tế
            cpuCores: hostCpuCores,            // Số nhân vCPU được cấp
            netDownKb: currentNetDownKbps,     // Tốc độ tải về (KB/s)
            netUpKb: currentNetUpKbps,         // Tốc độ gửi đi (KB/s)
            netTotalRxMb: totalNetRxMb,        // Tổng tải về (MB)
            netTotalTxMb: totalNetTxMb         // Tổng gửi đi (MB)
        };
    } catch (_) {
        const mem = process.memoryUsage();
        return {
            ramPercent: 0,
            ramUsedMb: 0,
            ramTotalMb: 512,
            botRssMb: Math.round(mem.rss / (1024 * 1024)),
            botHeapMb: Math.round(mem.heapUsed / (1024 * 1024)),
            botHeapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
            cpuPercent: 0,
            cpuCores: 1,
            netDownKb: 0,
            netUpKb: 0,
            netTotalRxMb: 0,
            netTotalTxMb: 0
        };
    }
}

function getPublicCurrentWindow(state) {
    if (!state.bot || !state.bot.currentWindow) return null;
    const win = state.bot.currentWindow;
    return {
        id: win.id,
        title: cleanMinecraftComponent(win.title) || 'GUI Sảnh / Máy Chủ',
        type: win.type,
        slotsCount: (win.slots || []).length,
        slots: (win.slots || []).map((s, idx) => s ? {
            slot: idx,
            name: cleanMinecraftComponent(s.name) || '',
            displayName: cleanMinecraftComponent(s.displayName) || cleanMinecraftComponent(s.name) || 'Vật phẩm',
            count: Number.isInteger(s.count) ? Math.max(1, Math.min(64, s.count)) : 1
        } : null)
    };
}

function publicBotState(state) {
    const mem = process.memoryUsage();
    const hw = getHostHardware();
    return {
        id: state.id,
        botId: BOT_ID,
        nodeId: BOT_ID,
        label: BOT_LABEL,
        username: state.username || '',
        status: state.status,
        ready: state.ready,
        ping: getPing(state),
        tps: Number.isFinite(state.serverTps) ? state.serverTps : (['afk', 'online', 'entering', 'authenticating'].includes(state.status) ? 20.0 : 0.0),
        serverTps: Number.isFinite(state.serverTps) ? state.serverTps : (['afk', 'online', 'entering', 'authenticating'].includes(state.status) ? 20.0 : 0.0),
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        heapMb: Math.round(mem.heapUsed / (1024 * 1024)),
        botHeapMb: Math.round(mem.heapUsed / (1024 * 1024)),
        heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
        ramRss: Math.round(mem.rss / (1024 * 1024)),
        ramRssMb: Math.round(mem.rss / (1024 * 1024)),
        ramHeap: Math.round(mem.heapUsed / (1024 * 1024)),
        memory: {
            rss: Math.round(mem.rss / (1024 * 1024)),
            rssMb: Math.round(mem.rss / (1024 * 1024)),
            heap: Math.round(mem.heapUsed / (1024 * 1024)),
            heapMb: Math.round(mem.heapUsed / (1024 * 1024)),
            heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024))
        },
        hostHardware: hw,
        system: hw,
        host: currentHost(state),
        port: PORT,

        uptimeSeconds:
            getUptimeSeconds(state),

        uptime:
            formatUptime(state),

        reconnectCount:
            state.reconnectCount,

        connectedAt:
            state.connectedAt,

        logRevision:
            state.logRevision,

        chatLogRevision:
            state.chatLogRevision,

        stateRevision:
            state.stateRevision,

        autoStartOnBoot:
            AUTO_START_ON_BOOT,

        hasCredentials:
            !!(state.username && state.password),

        ipAddress:
            state.publicIp || '',

        ipAddressUpdatedAt:
            state.publicIpUpdatedAt || null,

        settings: {
            ecoMode: state.settings.ecoMode !== false,
            autoTotem: state.settings.autoTotem !== false,
            antiHungry: state.settings.antiHungry !== false,
            autoReconnect: state.settings.autoReconnect !== false,
            antiAfkKick: state.settings.antiAfkKick !== false,
            spawnCommands: state.settings.spawnCommands || '',
            proxy: {
                enabled: state.settings?.proxy?.enabled === true,
                protocol: state.settings?.proxy?.protocol || 'socks5',
                host: state.settings?.proxy?.host || '',
                port: Number(state.settings?.proxy?.port) || 0,
                username: state.settings?.proxy?.username || '',
                password: state.settings?.proxy?.password ? '********' : ''
            }
        },
        ecoMode: state.settings.ecoMode !== false,

        totemCount:
            Number(state.inventoryState?.totemCount || 0),

        foodCount:
            Number(state.inventoryState?.foodCount || 0),

        autoChatScheduleCount:
            state.autoChatSchedules.length,

        locationState:
            state.locationState,

        health:
            state.bot && Number.isFinite(state.bot.health)
                ? Math.max(0, Math.min(Number(state.bot.health), 20))
                : 20,

        food:
            state.bot && Number.isFinite(state.bot.food)
                ? Math.max(0, Math.min(Number(state.bot.food), 20))
                : 20,

        isDead:
            !!(state.bot && state.bot.health === 0),

        deathCount:
            Number(state.deathCount || 0),

        lastDeathAt:
            state.lastDeathAt || null,

        lastDeathCoords:
            state.lastDeathCoords || '',

        roundedLocation:
            getRoundedBotCoordinates(state.bot),

        position:
            getBotPosition(state),

        dimension:
            getBotDimension(state),

        manuallyStopped: !!state.manuallyStopped,
        lastKickReason: state.lastKickReason || '',
        lastKickAt: state.lastKickAt || null,
        currentWindow: getPublicCurrentWindow(state)
    };
}


function publicBotCredentials(state) {
    return {
        ok: true,
        botId: BOT_ID,
        label: BOT_LABEL,
        username: state.username || '',
        password: state.password || ''
    };
}

function getReconnectDelay(state) {
    const attempt = Math.max(Number(state.reconnectAttempts || 0), 0);
    const baseDelay = 5000;   // Bắt đầu từ 5 giây
    const maxDelay = 30000;   // Tăng dần tối đa 30 giây
    const calcDelay = Math.min(maxDelay, baseDelay + attempt * 5000);
    // Phân phối ngẫu nhiên nhẹ (0 - 500ms) chống thundering herd
    const finalDelay = Math.min(maxDelay, calcDelay + Math.floor(Math.random() * 500));
    return finalDelay;
}

function scheduleAutoReconnect(state) {
    return scheduleReconnect(state);
}

function scheduleReconnect(state) {
    if (
        state.shuttingDown ||
        state.manuallyStopped ||
        !state.settings.autoReconnect ||
        state.reconnectTimer
    ) {
        return;
    }

    clearAfkTimers(state);

    state.ready = false;
    setBotStatus(state, 'connecting');

    const reconnectDelay =
        getReconnectDelay(state);

    state.reconnectAttempts++;

    state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;

        if (!state.manuallyStopped) {
            connectBot(state);
        }
    }, reconnectDelay);

    addLog(
        state,
        `Sẽ reconnect sau ${reconnectDelay / 1000}s.`
    );
}

function disconnectBot(
    state,
    reason = 'Stopped'
) {
    clearAllTimers(state);
    invalidateInventoryAction(state);

    state.connectionGeneration++;
    state.ready = false;
    state.serverTps = 0.0;
    state.tpsSamples = [];
    state.lastTimePacketAt = null;
    state.lastWorldAge = undefined;
    setBotStatus(state, 'offline');
    state.connectedAt = null;

    const currentBot = state.bot;
    state.bot = null;
    resetInventoryState(state);

    if (!currentBot) {
        return;
    }

    try {
        if (typeof currentBot.quit === 'function') {
            currentBot.quit(reason);
        }
    } catch (err) {
        console.log(
            `[BOT ${state.id}] Shutdown error: ${err.message}`
        );
    } finally {
        cleanupBotResources(currentBot);
    }
}

function stopBot(state, source = 'manual', persist = true) {
    if (source === 'manual') {
        markManualLifecycleAction(state);
    }

    state.manuallyStopped = true;
    if (persist) {
        saveBotSettingsFile(state.settings, state.autoChatSchedules, state.botSchedules, { manuallyStopped: true });
    }

    // Tạm dừng mọi lịch Auto Chat đang chạy
    if (Array.isArray(state.autoChatSchedules)) {
        for (const s of state.autoChatSchedules) {
            s.running = false;
        }
    }

    addLog(
        state,
        source === 'scheduler'
            ? 'Scheduler yêu cầu dừng bot.'
            : 'Dừng bot thủ công: Toàn bộ tính năng, lịch trình, auto chat & reconnect đều tạm dừng.'
    );

    disconnectBot(
        state,
        source === 'scheduler'
            ? 'Stopped by scheduler'
            : 'Stopped from web panel'
    );
}

function startBot(state, source = 'manual') {
    if (source === 'manual') {
        markManualLifecycleAction(state);
    }

    if (state.shuttingDown) {
        return false;
    }

    if (
        !state.username ||
        !state.password
    ) {
        addLog(
            state,
            'Không thể chạy: thiếu username hoặc password.'
        );

        setBotStatus(state, 'offline');

        return false;
    }

    state.manuallyStopped = false;
    saveBotSettingsFile(state.settings, state.autoChatSchedules, state.botSchedules, { manuallyStopped: false });

    clearAllTimers(state);
    if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
    }

    state.ready = false;
    state.connectedAt = null;
    state.reconnectAttempts = 0;
    state.lastAuthDnActionAt = 0;
    state.serverTps = 20.0;
    state.tpsSamples = [];
    state.lastTimePacketAt = null;
    setBotStatus(state, 'connecting');

    if (state.bot) {
        disconnectBot(
            state,
            'Restart from web panel'
        );

        state.manuallyStopped = false;
    }

    connectBot(state);

    return true;
}

function registerEvents(state, bot, connectionGeneration = state.connectionGeneration) {
    // ⚡ Ghost Freeze Tracker: Cập nhật timestamp mỗi khi nhận packet từ server
    if (bot._client) {
        bot._client.on('packet', () => {
            state.lastPacketReceivedAt = Date.now();
        });
    }

    // ⚡ REAL-TIME MINECRAFT SERVER TPS MONITORING (Rolling 10-sample tick tracking)
    bot.on('time', () => {
        if (state.bot !== bot) return;
        const now = Date.now();
        if (state.lastTimePacketAt) {
            const deltaMs = now - state.lastTimePacketAt;
            if (deltaMs > 300) {
                let currentTps = 20.0;
                if (bot.time && (typeof bot.time.age === 'number' || typeof bot.time.age === 'bigint')) {
                    const age = Number(bot.time.age);
                    if (state.lastWorldAge !== undefined && age > state.lastWorldAge) {
                        const ticks = age - state.lastWorldAge;
                        currentTps = Math.min(20.0, Math.max(0.0, (ticks / (deltaMs / 1000))));
                    } else {
                        currentTps = Math.min(20.0, Math.max(0.0, (20 / (deltaMs / 1000))));
                    }
                    state.lastWorldAge = age;
                } else {
                    currentTps = Math.min(20.0, Math.max(0.0, (20 / (deltaMs / 1000))));
                }
                state.tpsSamples = state.tpsSamples || [];
                state.tpsSamples.push(currentTps);
                if (state.tpsSamples.length > 10) state.tpsSamples.shift();
                const avg = state.tpsSamples.reduce((a, b) => a + b, 0) / state.tpsSamples.length;
                state.serverTps = Math.round(avg * 10) / 10;
            }
        }
        state.lastTimePacketAt = now;
    });

    bot.on('chat', (username, message, translate, jsonMsg) => {
        if (
            !message ||
            state.bot !== bot
        ) {
            return;
        }

        const cleanMessage =
            cleanMinecraftText(message);

        if (!cleanMessage) {
            return;
        }

        if (
            username === bot.username &&
            state.lastWebChatText === cleanMessage &&
            Date.now() - state.lastWebChatAt <= 1500
        ) {
            return;
        }

        if (
            isRecentChatMessage(
                state,
                cleanMessage,
                username,
                ''
            )
        ) {
            return;
        }

        addChatLog(
            state,
            username,
            cleanMessage
        );
    });

    // ⚡ INSTANT TOTEM REFLEX (< 50ms)
    bot.on('entityHurt', (entity) => {
        if (state.bot !== bot) return;
        if (entity === bot.entity) fastEquipTotem(state);
    });

    // ⚡ Phản xạ tức thì khi Totem phát nổ (Minecraft status 35 = Totem used)
    bot.on('entityStatus', (entity, status) => {
        if (state.bot !== bot) return;
        if (entity === bot.entity && status === 35) {
            addLog(state, '⚡ [TOTEM] Totem vừa phát nổ cứu mạng! Đang tức tốc lắp Totem mới vào tay phụ...');
            fastEquipTotem(state);
            sendBotDirectAlert('totem_popped', 'Totem vừa phát nổ cứu mạng bot!', { 'Máu hiện tại': bot.health, 'Totem còn lại': (state.inventoryState?.totemCount ?? 0) });
        }
    });

    bot.on('health', () => {
        if (state.bot !== bot) return;
        const hp = Number.isFinite(bot.health) ? bot.health : 20;
        if (hp <= 10 && hp > 0 && !state.lowHealthAlertSent) {
            state.lowHealthAlertSent = true;
            sendBotDirectAlert('low_health', `Máu của Bot đang ở mức nguy hiểm (${hp}/20 HP - dưới 5 tim)!`, {
                'Máu hiện tại': `${hp} / 20 HP`,
                'Thức ăn': `${bot.food || 0} / 20`,
                'Totem': String(state.inventoryState?.totemCount ?? 0)
            });
            addLog(state, `⚠️ [HEALTH] Cảnh báo máu yếu: còn ${hp}/20 HP!`);
        } else if (hp > 14) {
            state.lowHealthAlertSent = false;
        }
    });

    bot.on('playerCollect', () => {
        if (state.bot !== bot) return;
        scanInventory(state, bot);
    });

    bot.on('error', err => {
        if (
            state.bot !== bot ||
            state.connectionGeneration !== connectionGeneration
        ) {
            return;
        }

        const msg = String(err?.message || err || 'Lỗi không xác định');
        const code = String(err?.code || '');
        let diag = msg;
        if (code === 'ECONNRESET' || msg.includes('ECONNRESET')) {
            diag = 'Máy chủ KingMC ngắt kết nối đột ngột (ECONNRESET)';
        } else if (code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT')) {
            diag = 'Hết thời gian chờ kết nối máy chủ (ETIMEDOUT)';
        } else if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND')) {
            diag = 'Không tìm thấy máy chủ sgp.kingmc.vn (ENOTFOUND)';
        } else if (code === 'EPIPE' || msg.includes('EPIPE')) {
            diag = 'Mất kết nối đường truyền socket (EPIPE)';
        } else if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
            diag = 'Máy chủ từ chối kết nối (Server offline hoặc khởi động lại)';
        }

        addLog(
            state,
            `[MẠNG] ${diag}`
        );

        const isSocketError = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED'].some(c => code === c || msg.includes(c));
        if (isSocketError) {
            cleanupBotResources(bot);
        }

        if (state.settings.autoReconnect && !state.reconnectTimer) {
            scheduleReconnect(state);
        }
    });

    bot.on('kicked', reason => {
        if (
            state.bot !== bot ||
            state.connectionGeneration !== connectionGeneration
        ) {
            return;
        }

        const reasonText =
            typeof reason === 'string'
                ? reason
                : JSON.stringify(reason);

        if (!state.manuallyStopped) {
            sendBotDirectAlert('kicked', 'Bot đã bị kick khỏi server KingMC.', { 'Lý do': reasonText });
        }

        const cleanedKickReason = cleanMinecraftText(reasonText);
        state.lastKickReason = cleanedKickReason;
        state.lastKickAt = new Date().toISOString();
        setBotStatus(state, 'kicked');
        state.ready = false;
        clearManagerTimers(state);
        clearLocationTimers(state);
        clearAfkTimers(state);
        invalidateInventoryAction(state);
        cleanupBotResources(bot);

        addLog(
            state,
            `Bị kick: ${cleanMinecraftText(reasonText)}`
        );

        if (state.settings.autoReconnect) {
            scheduleReconnect(state);
        }
    });

    bot.on('end', () => {
        const isCurrentBot =
            state.bot === bot &&
            state.connectionGeneration === connectionGeneration;

        if (isCurrentBot) {
            state.bot = null;
            clearManagerTimers(state);
            clearAfkTimers(state);
            clearLocationTimers(state);
            invalidateInventoryAction(state);
            state.ready = false;
            state.connectedAt = null;
            resetInventoryState(state);
        }

        // Ended/stale Mineflayer instances must not retain listeners or sockets.
        cleanupBotResources(bot);

        if (!isCurrentBot) {
            return;
        }

        if (state.manuallyStopped) {
            setBotStatus(state, 'offline');
            addLog(state, 'Đã ngắt kết nối.');
            return;
        }

        if (state.status !== 'kicked') {
            setBotStatus(state, 'offline');
        }
        addLog(state, 'Mất kết nối.');

        state.reconnectCount++;
        addLog(
            state,
            `Reconnect #${state.reconnectCount}.`
        );

        if (!state.settings.autoReconnect) {
            addLog(state, '[RECONNECT] Auto reconnect đang tắt.');
            return;
        }

        if (HOSTS.length > 1 && state.reconnectAttempts >= 5) {
            state.hostIndex = (state.hostIndex + 1) % HOSTS.length;
            state.reconnectAttempts = 0;
            const nextHost = currentHost(state);
            addLog(state, `[HOST] 🔄 Đã thử 5 lần reconnect không thành công. Tự động xoay sang server IP tiếp theo: ${nextHost} (Thứ tự: ${HOSTS.join(' → ')}).`);
        }

        scheduleReconnect(state);
    });

    bot.once('spawn', () => {
        if (
            state.bot !== bot ||
            state.connectionGeneration !== connectionGeneration ||
            state.manuallyStopped
        ) {
            return;
        }

        setBotStatus(state, 'online');
        state.ready = false;
        state.connectedAt = Date.now();
        state.reconnectAttempts = 0;

        startBackgroundManagers(
            state,
            bot
        );

        startLocationMonitor(state, bot);
        sendBotDirectAlert('spawn', 'Bot đã spawn thành công vào server KingMC.');
    });

    bot.on('death', () => {
        if (
            state.bot === bot &&
            state.connectionGeneration === connectionGeneration
        ) {
            state.deathCount = (state.deathCount || 0) + 1;
            state.lastDeathAt = Date.now();
            const deathPos = bot.entity?.position
                ? `(X: ${Math.round(bot.entity.position.x)}, Y: ${Math.round(bot.entity.position.y)}, Z: ${Math.round(bot.entity.position.z)})`
                : 'Không xác định';
            state.lastDeathCoords = deathPos;

            sendBotDirectAlert('death', 'Bot đã chết trong game! Đang chuẩn bị tự động hồi sinh...', {
                'Tọa độ tử vong': deathPos,
                'Tổng lần chết': String(state.deathCount),
                'Totem còn lại': String(state.inventoryState?.totemCount ?? 0)
            });
            addLog(
                state,
                `[LIFE] 💀 Bot đã chết tại ${deathPos} (Lần #${state.deathCount}). Đang chuẩn bị tự động hồi sinh...`
            );

            if (typeof botSupabase !== 'undefined' && botSupabase && botSupabase.isEnabled()) {
                void botSupabase.logBotAction({
                    action: 'BOT_DEATH',
                    actionLabel: '💀 Bot tử vong',
                    category: 'BOT_CONTROL',
                    details: `Bot tử vong tại ${deathPos} (Lần #${state.deathCount})`,
                    status: 'SUCCESS'
                });
            }
            state.ready = false;
            setBotStatus(state, 'connecting');
            clearAfkTimers(state);
            resetLocationFlowState(state, 'bot đã chết, chuẩn bị hồi sinh');

            setTimeout(() => {
                if (
                    state.bot === bot &&
                    state.connectionGeneration === connectionGeneration &&
                    !state.manuallyStopped
                ) {
                    try {
                        if (typeof bot.respawn === 'function') {
                            bot.respawn();
                            addLog(state, '[LIFE] Đã tự động hồi sinh (respawn). Bot đang quay lại cụm đăng nhập/Lobby...');
                        }
                    } catch (e) {
                        addLog(state, `[LIFE] Lỗi khi tự động hồi sinh: ${e.message}`);
                    }
                }
            }, 2000);
        }
    });

    bot.on('message', jsonMsg => {
        if (
            state.bot !== bot ||
            state.connectionGeneration !== connectionGeneration
        ) {
            return;
        }

        handleServerMessage(
            state,
            bot,
            jsonMsg
        );
    });

    bot.on('windowOpen', window => {
        if (
            state.bot !== bot ||
            state.connectionGeneration !== connectionGeneration
        ) {
            return;
        }

        let title = '';

        try {
            const rawTitle =
                window && window.title
                    ? window.title
                    : '';

            if (typeof rawTitle === 'string') {
                title =
                    cleanMinecraftText(
                        rawTitle
                    );
            } else if (
                rawTitle &&
                typeof rawTitle === 'object'
            ) {
                title =
                    cleanMinecraftText(
                        rawTitle.text ||
                        rawTitle.toString()
                    );
            } else if (rawTitle) {
                title =
                    cleanMinecraftText(
                        rawTitle.toString()
                    );
            }
        } catch (_) {
            title = '';
        }

        if (title) {
            addLog(
                state,
                `Đã mở GUI ${title}.`
            );
        } else {
            addLog(
                state,
                'Đã mở GUI.'
            );
        }
    });
}

function createProxySocket(proxy, destination, callback) {
    const protocol = String(proxy.protocol || 'socks5').toLowerCase();
    const proxyHost = String(proxy.host || '').trim();
    const proxyPort = Number(proxy.port);

    if (!proxyHost || !proxyPort) {
        return callback(new Error('Proxy Host hoặc Port không hợp lệ.'));
    }

    if (protocol === 'socks5' || protocol === 'socks4' || protocol === 'socks') {
        let SocksClient;
        try {
            SocksClient = require('socks').SocksClient;
        } catch (e) {
            return callback(new Error('Thư viện socks chưa được cài đặt trên hệ thống.'));
        }
        const socksOptions = {
            proxy: {
                host: proxyHost,
                port: proxyPort,
                type: protocol === 'socks4' ? 4 : 5
            },
            command: 'connect',
            destination: {
                host: destination.host,
                port: Number(destination.port)
            },
            timeout: 15000
        };
        if (proxy.username) {
            socksOptions.proxy.userId = String(proxy.username);
            socksOptions.proxy.password = String(proxy.password || '');
        }
        SocksClient.createConnection(socksOptions, (err, info) => {
            if (err) return callback(err);
            callback(null, info.socket);
        });
    } else {
        // HTTP / HTTPS CONNECT Proxy
        const net = require('net');
        const socket = net.connect({ host: proxyHost, port: proxyPort }, () => {
            let req = `CONNECT ${destination.host}:${destination.port} HTTP/1.1\r\nHost: ${destination.host}:${destination.port}\r\n`;
            if (proxy.username) {
                const creds = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
                req += `Proxy-Authorization: Basic ${creds}\r\n`;
            }
            req += `Proxy-Connection: Keep-Alive\r\n\r\n`;
            socket.write(req);
        });

        socket.setTimeout(15000);
        socket.once('timeout', () => {
            socket.destroy(new Error('Proxy connection timeout sau 15 giây.'));
        });

        let buf = '';
        function onData(chunk) {
            buf += chunk.toString('utf8');
            if (buf.includes('\r\n\r\n')) {
                socket.removeListener('data', onData);
                socket.setTimeout(0);
                const firstLine = buf.split('\r\n')[0] || '';
                if (/HTTP\/1\.[01]\s+200/.test(firstLine)) {
                    callback(null, socket);
                } else {
                    socket.destroy();
                    callback(new Error(`Proxy trả về lỗi HTTP: ${firstLine}`));
                }
            }
        }
        socket.on('data', onData);
        socket.once('error', (err) => callback(err));
    }
}

function connectBot(state) {
    if (state.shuttingDown || state.manuallyStopped) {
        return;
    }

    if (!state.username || !state.username.trim()) {
        setBotStatus(state, 'offline');
        addLog(
            state,
            '[CẢNH BÁO] Chưa cấu hình USERNAME. Vui lòng nhập thông tin tài khoản trên Web hoặc cấu hình BOT_CONFIG trong file bot.js.'
        );
        return;
    }

    clearAfkTimers(state);
    clearReconnectTimer(state);

    if (state.bot) {
        disconnectBot(state, 'Replacing stale connection');
        state.manuallyStopped = false;
    }

    state.connectionGeneration++;
    const connectionGeneration = state.connectionGeneration;

    state.ready = false;
    setBotStatus(state, 'connecting');

    const host = currentHost(state);

    addLog(
        state,
        `Đang kết nối tới ${host}:${PORT} | ` +
        `Minecraft ${MC_VERSION} | ` +
        `ViewDistance ${VIEW_DISTANCE}`
    );

    let bot;

    try {
        const botOptions = {
            host,
            port: PORT,
            username: state.username,
            version: MC_VERSION,
            auth: 'offline',

            keepAlive: true,
            checkTimeoutInterval:
                CHECK_TIMEOUT_INTERVAL,

            viewDistance:
                VIEW_DISTANCE,

            logErrors: false,

            chat: 'enabled',
            defaultChatPatterns: true
        };

        if (state.settings?.proxy?.enabled && state.settings.proxy.host && state.settings.proxy.port) {
            const p = state.settings.proxy;
            addLog(
                state,
                `Đang kết nối qua Proxy ${p.protocol || 'socks5'}://${p.host}:${p.port}...`
            );
            botOptions.connect = (client) => {
                createProxySocket(p, { host, port: PORT }, (err, socket) => {
                    if (err) {
                        addLog(state, `Lỗi kết nối qua Proxy: ${err.message}`);
                        client.emit('error', new Error(`Proxy error: ${err.message}`));
                        return;
                    }
                    client.setSocket(socket);
                    client.emit('connect');
                });
            };
        }

        bot = mineflayer.createBot(botOptions);
    } catch (err) {
        setBotStatus(state, 'offline');

        addLog(
            state,
            `Lỗi khởi tạo Mineflayer: ${err.message}`
        );

        scheduleReconnect(state);

        return;
    }

    state.bot = bot;
    state.loginFlowStartedAt = Date.now();
    state.lastPacketReceivedAt = Date.now();
    startSmartWatchdog(state);

    registerEvents(
        state,
        bot,
        connectionGeneration
    );
}

const BLOCKED_MC_LOG_PATTERNS = [
        'đăng nhập bằng lệnh',
        'đăng nhập thành công',
        'phiên đăng nhập đã được kết nối trở lại',
        'dùng lệnh /rtp để dịch chuyển ngẫu nhiên tới nơi sinh tồn và xây căn cứ',
        'donate sẽ góp phần giúp Server',
        'xin lưu ý: giá bán item có thể tăng hoặc giảm để cân bằng server tránh lạm phát',
        'chơi server dưới 180 phút mỗi ngày để đảm bảo sức khỏe...',
        'server nghiêm cấm mọi hành vi',
        'để có rank plus và key (/warp crate), dùng lệnh /key hoặc /donate',
        'có kinh phí để phát triển hơn',
        'những người Donate sẽ nhận được',
        'hack cheat',
        'nếu bị phát hiện sẽ phạt theo luật',
        'xu, Money, Danh vọng được dùng để',
        'mua 1 số vật phẩm trong map',
        'hãy là 1 người chơi văn minh',
        'bạn đã đăng nhập!',
        'đã donate key, rank bằng thẻ được rồi nha (/key)',
        'kingmc.vn',
        'tự do xây dựng, tự do pvp và làm những điều mình thích nhưng phải tuân thủ luật',
        'nếu phát hiện người chơi khác có',
        'hành vi gian lận',
        'và gửi cho admin',
        'ai là newbie thì dùng lệnh /commands để xem danh sách lệnh cơ bản, /rules để xem luật'
    ];

function handleServerMessage(
    state,
    bot,
    jsonMsg
) {
    if (!isCurrentBot(state, bot) || state.manuallyStopped) {
        return;
    }

    const text = jsonMsg.toString();
    const cleanMsg = cleanMinecraftText(text);
    const lowerMsg = cleanMsg.toLowerCase();

    const customChat = parseCustomChatLine(cleanMsg);

    const customChatIsOwnRecentWebMessage = !!(
        customChat &&
        customChat.username === bot.username &&
        cleanMinecraftText(state.lastWebChatText) === customChat.message &&
        Date.now() - state.lastWebChatAt <= 2500
    );

    if (
        customChat &&
        !customChatIsOwnRecentWebMessage &&
        !isRecentChatMessage(
            state,
            customChat.message,
            customChat.username,
            customChat.role
        )
    ) {
        addChatLog(
            state,
            customChat.username,
            customChat.message,
            customChat.role
        );
    }

    const shouldShowMcLog =
        !BLOCKED_MC_LOG_PATTERNS.some(
            pattern => lowerMsg.includes(pattern)
        );

    if (
        shouldShowMcLog &&
        !customChat &&
        !isRecentChatMessage(state, cleanMsg) &&
        !(
            /^<[^>]{1,32}>\s/.test(cleanMsg) ||
            /^\[[^\]]{1,24}\]\s*\S{1,32}\s*[>:»]\s*/.test(cleanMsg) ||
            /^\S{1,32}\s*[>:»]\s+/.test(cleanMsg)
        )
    ) {
        // Đưa các thông báo chung từ server KingMC vào Chat Log để xem lại bất cứ lúc nào
        addChatLog(state, 'Server', cleanMsg, 'SYSTEM');

        // Chỉ đưa vào Event Log nếu là thông báo hệ thống quan trọng ảnh hưởng đến bot
        const isCriticalSystemEvent = /bảo trì|kick|ban|khóa|cảnh báo|restart|ngắt kết nối/i.test(lowerMsg);
        if (isCriticalSystemEvent) {
            addLog(state, `[MC-EVENT] ${cleanMsg}`);
        }
    }

    if (lowerMsg.includes('kingmc.vn')) {
        const kind = getLocationKind(bot);

        if (kind === 'login') {
            state.locationState = 'login';
            state.ready = false;
            if (state.status === 'afk' || state.status === 'online') {
                setBotStatus(state, 'authenticating');
            }
        } else if (kind === 'lobby') {
            state.locationState = 'lobby';
            state.ready = false;
            if (state.status === 'afk' || state.status === 'online') {
                setBotStatus(state, 'entering');
            }
        }

        return;
    }

    // Fallback registration/login messages are retained as a trigger,
    // but coordinate confirmation remains authoritative for status/flow.
    if (
        state.password &&
        (
            lowerMsg.includes('/dk') ||
            lowerMsg.includes('dang ky bang lenh') ||
            lowerMsg.includes('dang ky') ||
            lowerMsg.includes('/register')
        )
    ) {
        const kind = getLocationKind(bot);
        if (kind === 'login') {
            const now = Date.now();
            if (
                now - state.lastAuthTime > 3000 &&
                now - state.lastLoginActionAt > 1500
            ) {
                state.lastAuthTime = now;
                state.lastLoginActionAt = now;
                try {
                    bot.chat(`/register ${state.password} ${state.password}`);
                    addLog(state, '[FLOW] Message register xác nhận → gửi /register.');
                } catch (err) {
                    addLog(state, `[FLOW] /register lỗi: ${err.message}`);
                }
            }
        }
        return;
    }

    if (
        state.password &&
        (
            lowerMsg.includes('/dn') ||
            lowerMsg.includes('vui long') ||
            lowerMsg.includes('dang nhap') ||
            lowerMsg.includes('/login')
        )
    ) {
        const kind = getLocationKind(bot);
        if (kind === 'login') {
            const now = Date.now();
            if (
                now - state.lastAuthTime > 3000 &&
                now - state.lastLoginActionAt > 1500
            ) {
                state.lastAuthTime = now;
                state.lastLoginActionAt = now;
                try {
                    bot.chat(`/login ${state.password}`);
                    addLog(state, '[FLOW] Message login xác nhận → gửi /login.');
                } catch (err) {
                    addLog(state, `[FLOW] /login lỗi: ${err.message}`);
                }
            }
        }
    }
}

function startAfkRoutine(state, expectedBot = state.bot) {
    const bot = expectedBot;

    if (
        state.shuttingDown ||
        state.manuallyStopped ||
        !bot ||
        state.bot !== bot
    ) {
        return;
    }

    if (getLocationKind(bot) !== 'lobby') {
        state.ready = false;
        state.locationFlowBusy = false;
        return;
    }

    state.locationFlowBusy = true;
    clearAfkTimers(state);
    if (state.locationConfirmTimer) {
        clearTimeout(state.locationConfirmTimer);
        state.locationConfirmTimer = null;
    }
    state.pendingAfkConfirmation = false;
    state.ready = false;
    setBotStatus(state, 'entering');

    const menuCommands = ['/menu', '/gui'];
    const command = menuCommands[state.menuCommandIndex % menuCommands.length];

    const menuTimer = setTimeout(() => {
        if (
            state.shuttingDown ||
            state.manuallyStopped ||
            state.bot !== bot ||
            getLocationKind(bot) !== 'lobby'
        ) {
            // Never leave locationFlowBusy locked when a delayed timer fires
            // after a teleport, reconnect, or location change.
            if (state.bot === bot && !state.manuallyStopped) {
                state.locationFlowBusy = false;
                state.pendingAfkConfirmation = false;
            }
            return;
        }

        try {
            bot.chat(command);
            addLog(state, `[FLOW] Gửi ${command}.`);
        } catch (err) {
            addLog(state, `[FLOW] ${command} lỗi: ${err.message}`);
            scheduleLocationRetry(state, bot, 'lobby');
            return;
        }

        const clickTimer = setTimeout(() => {
            if (
                state.shuttingDown ||
                state.manuallyStopped ||
                state.bot !== bot
            ) {
                if (state.bot === bot && !state.manuallyStopped) {
                    state.locationFlowBusy = false;
                    state.pendingAfkConfirmation = false;
                }
                return;
            }

            const currentWindow = bot.currentWindow;

            if (!currentWindow) {
                state.menuCommandIndex++;
                state.locationFlowBusy = false;
                addLog(state, `Không có GUI sau ${command}. Sẽ thử lại flow.`);
                scheduleLocationRetry(state, bot, 'lobby');
                return;
            }

            try {
                if (getLocationKind(bot) !== 'lobby') {
                    state.ready = false;
                    state.locationFlowBusy = false;
                    state.pendingAfkConfirmation = false;
                    return;
                }

                bot.clickWindow(24, 0, 0);

                state.ready = false;
                state.pendingAfkConfirmation = true;
                setBotStatus(state, 'entering');

                addLog(state, 'Đã click slot 24. Chờ xác nhận tọa độ trước khi đánh dấu AFK.');

                if (state.locationConfirmTimer) {
                    clearTimeout(state.locationConfirmTimer);
                }

                state.locationConfirmTimer = setTimeout(() => {
                    state.locationConfirmTimer = null;
                    confirmAfkAfterClick(state, bot);
                }, AFK_CONFIRM_DELAY_MS);
            } catch (err) {
                state.ready = false;
                state.pendingAfkConfirmation = false;
                state.locationFlowBusy = false;
                setBotStatus(state, 'entering');
                addLog(state, `Lỗi click slot 24: ${err.message}`);
                scheduleLocationRetry(state, bot, 'lobby');
            }
        }, AFK_MENU_CLICK_DELAY);

        state.afkTimers.push(clickTimer);
    }, AFK_MENU_DELAY);

    state.afkTimers.push(menuTimer);
}

const HTML = String.raw`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta
    name="viewport"
    content="width=device-width,initial-scale=1"
>
<title>KBOT Worker — ${BOT_LABEL} • Cloud AFK Engine V10.0</title>

<style>
:root {
  color-scheme: dark;
  --bg: #070a0f;
  --bg-gradient: radial-gradient(circle at 14% 16%, rgba(26, 42, 66, 0.75) 0%, transparent 45%),
                 radial-gradient(circle at 86% 84%, rgba(32, 22, 58, 0.65) 0%, transparent 50%),
                 radial-gradient(circle at 50% 50%, rgba(13, 21, 33, 0.9) 0%, #070a0f 100%);
  --card: rgba(15, 23, 34, 0.82);
  --card-hover: rgba(21, 33, 49, 0.92);
  --card2: rgba(11, 17, 26, 0.7);
  --border: rgba(255, 255, 255, 0.08);
  --border-glow: rgba(77, 163, 255, 0.45);
  --text: #f0f6fc;
  --muted: #8b9bb4;
  --green: #30d158;
  --green-glow: rgba(48, 209, 88, 0.35);
  --red: #ff453a;
  --red-glow: rgba(255, 69, 58, 0.35);
  --yellow: #ffd60a;
  --yellow-glow: rgba(255, 214, 10, 0.35);
  --blue: #4da3ff;
  --blue-glow: rgba(77, 163, 255, 0.35);
  --accent: #58a6ff;
  --gold: #f59e0b;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg-gradient);
  background-attachment: fixed;
  color: var(--text);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

h1, h2, h3, p, label {
  margin: 0;
}

button, input, select, textarea {
  font: inherit;
}

button {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: linear-gradient(180deg, #1c2734 0%, #151e28 100%);
  color: var(--text);
  padding: 9px 14px;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.25);
  user-select: none;
}

button:hover, button:hover:not(:disabled) {
  background: linear-gradient(180deg, #253444 0%, #1a2734 100%);
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}

button:active, button:active:not(:disabled) {
  transform: scale(0.97);
}

button:focus-visible, input:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

button.primary {
  background: linear-gradient(180deg, #1f7ae0 0%, #1562b8 100%);
  border-color: #388bfd;
  box-shadow: 0 2px 8px rgba(31, 122, 224, 0.35);
}

button.primary:hover, button.primary:hover:not(:disabled) {
  background: linear-gradient(180deg, #2b88f0 0%, #1a6fcf 100%);
  box-shadow: 0 4px 15px rgba(31, 122, 224, 0.5);
}

button.danger {
  background: linear-gradient(180deg, #a8282b 0%, #7d1b1d 100%);
  border-color: #da3633;
  box-shadow: 0 2px 8px rgba(218, 54, 51, 0.35);
}

button.danger:hover, button.danger:hover:not(:disabled) {
  background: linear-gradient(180deg, #c43236 0%, #912022 100%);
  box-shadow: 0 4px 15px rgba(218, 54, 51, 0.5);
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none !important;
}

input, select, textarea {
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(10, 16, 24, 0.7);
  color: var(--text);
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

input:focus, select:focus, textarea:focus {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px rgba(77, 163, 255, 0.2);
}

.app {
  width: min(1140px, calc(100% - 32px));
  margin: 0 auto;
  padding: 24px 0 48px;
}

.topbar, .header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
}

.page-title {
  font-size: 24px;
  font-weight: 850;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
  background: linear-gradient(135deg, #ffffff 30%, #a5c2eb 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.page-subtitle {
  color: var(--muted);
  font-size: 13px;
  margin: 0 0 16px;
}

/* KPI Grid */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.kpi-card {
  position: relative;
  background: var(--card);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 14px 16px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  overflow: hidden;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s;
}

.kpi-card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.2);
}

.kpi-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--blue), transparent);
}
.kpi-card:nth-child(2)::before { background: linear-gradient(90deg, var(--green), transparent); }
.kpi-card:nth-child(3)::before { background: linear-gradient(90deg, var(--yellow), transparent); }
.kpi-card:nth-child(4)::before { background: linear-gradient(90deg, var(--red), transparent); }
.kpi-card:nth-child(5)::before { background: linear-gradient(90deg, var(--gold), transparent); }

.kpi-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.kpi-value {
  font-size: 24px;
  font-weight: 900;
  margin-top: 6px;
  letter-spacing: -0.02em;
}

.top-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
  align-items: center;
}

.search-box {
  flex: 1;
  min-width: 230px;
}

/* Status Filter Tabs */
.filter-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}

.tab-btn {
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 650;
  border: 1px solid var(--border);
  background: rgba(14, 21, 31, 0.65);
  color: var(--muted);
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.tab-btn:hover {
  background: rgba(25, 36, 52, 0.85);
  color: var(--text);
  transform: translateY(-1px);
}

.tab-btn.active {
  background: linear-gradient(180deg, #1f7ae0 0%, #1562b8 100%);
  color: #fff;
  border-color: #388bfd;
  box-shadow: 0 2px 10px rgba(31, 122, 224, 0.4);
}

/* Grids & Panels */
.bot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
  gap: 16px;
}

.bot-card, .panel {
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--card);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  padding: 18px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.22s ease, box-shadow 0.22s ease;
}

.bot-card {
  cursor: pointer;
  display: flex;
  flex-direction: column;
}

.bot-card:hover {
  border-color: var(--border-glow);
  transform: translateY(-3px);
  box-shadow: 0 12px 35px rgba(0, 0, 0, 0.45), 0 0 16px rgba(77, 163, 255, 0.12);
}

.bot-card h2 {
  font-size: 18px;
  margin: 0 0 14px;
  font-weight: 750;
}

.card-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.card-quick-actions {
  display: flex;
  gap: 7px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.card-quick-actions button {
  flex: 1;
  font-size: 11px;
  padding: 7px 8px;
  border-radius: 8px;
}

.small {
  font-size: 11px;
  padding: 7px 10px;
}

/* Sound Alert Toggle Button */
.sound-btn {
  font-size: 11px;
  padding: 7px 12px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.sound-btn.active {
  border-color: var(--green);
  color: var(--green);
  background: rgba(48, 209, 88, 0.12);
  box-shadow: 0 0 8px var(--green-glow);
}

/* Capacity Badge */
.capacity-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 750;
  padding: 5px 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
}

.capacity-badge.warning {
  border-color: var(--yellow);
  color: var(--yellow);
  background: rgba(255, 214, 10, 0.12);
}

.capacity-badge.danger {
  border-color: var(--red);
  color: var(--red);
  background: rgba(255, 69, 58, 0.14);
}

/* Modals */
.modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.72);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 100;
}

@keyframes modalZoomIn {
  from { opacity: 0; transform: scale(0.93) translateY(12px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

.modal-card {
  width: min(520px, 100%);
  background: rgba(18, 27, 40, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 18px;
  padding: 22px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  animation: modalZoomIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.modal-card h3 {
  margin: 0 0 16px;
  font-size: 18px;
  font-weight: 750;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.form-row label {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

/* Pulsing Status Indicators */
@keyframes pulseGreen {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(48, 209, 88, 0.7); }
  50% { transform: scale(1.15); box-shadow: 0 0 12px 3px rgba(48, 209, 88, 0.4); }
}

@keyframes pulseYellow {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 214, 10, 0.7); }
  50% { transform: scale(1.15); box-shadow: 0 0 12px 3px rgba(255, 214, 10, 0.4); }
}

@keyframes pulseRed {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(255, 69, 58, 0.7); }
  50% { transform: scale(1.15); box-shadow: 0 0 12px 3px rgba(255, 69, 58, 0.4); }
}

.status-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  margin-bottom: 12px;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  background: #697582;
  transition: all 0.25s ease;
}

.dot.green {
  background: var(--green);
  animation: pulseGreen 2.2s infinite ease-in-out;
}

.dot.yellow {
  background: var(--yellow);
  animation: pulseYellow 2s infinite ease-in-out;
}

.dot.red {
  background: var(--red);
  animation: pulseRed 2.5s infinite ease-in-out;
}

.dot.blue {
  background: var(--blue);
}

.dot.gray {
  background: #94a3b8;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.summary-item {
  padding: 9px 10px;
  border-radius: 10px;
  background: var(--card2);
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.summary-label {
  color: var(--muted);
  font-size: 9px;
  font-weight: 600;
  margin-bottom: 4px;
  text-transform: uppercase;
}

.summary-value {
  font-size: 12px;
  font-weight: 700;
  word-break: break-word;
}

/* Detail Page Layout */
.detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}

.detail-header .title-wrap {
  flex: 1;
}

.detail-title {
  font-size: 24px;
  font-weight: 850;
  margin: 0;
}

.detail-subtitle {
  color: var(--muted);
  font-size: 13px;
  margin-top: 4px;
}

.grid {
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  gap: 18px;
}

.panel h3 {
  font-size: 15px;
  font-weight: 750;
  margin: 0 0 14px;
  letter-spacing: -0.01em;
}

.big-status {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 800;
  margin-bottom: 14px;
}

.info {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.info-item {
  padding: 10px 12px;
  border-radius: 11px;
  background: var(--card2);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.info-label {
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 4px;
  text-transform: uppercase;
}

.info-value {
  font-size: 14px;
  font-weight: 700;
  word-break: break-word;
}

.controls {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.chat-panel {
  display: flex;
  flex-direction: column;
}

.chat-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.chat-row {
  display: flex;
  gap: 8px;
}

.chat-form {
  margin-top: 10px;
}

.chip-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.chip {
  padding: 5px 11px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
}

.chip:hover {
  background: rgba(77, 163, 255, 0.22);
  border-color: var(--blue);
  color: #fff;
  transform: translateY(-1px);
  box-shadow: 0 0 10px var(--blue-glow);
}

.chip:active {
  transform: scale(0.95);
}

.copyable {
  cursor: pointer;
  transition: all 0.18s ease;
}

.copyable:hover {
  border-color: var(--blue);
  background: rgba(77, 163, 255, 0.08);
  box-shadow: 0 0 8px var(--blue-glow);
}

.log, .chat-log {
  height: 440px;
  overflow: auto;
  background: rgba(8, 12, 17, 0.95);
  border: 1px solid var(--border);
  border-radius: 11px;
  padding: 12px;
  font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.5);
}

.line {
  padding: 2px 0;
}

.note {
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.45;
}

@keyframes toastSlideIn {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

.toast {
  position: fixed;
  right: 18px;
  bottom: 18px;
  display: none;
  max-width: 380px;
  padding: 12px 16px;
  border: 1px solid var(--border-glow);
  border-radius: 12px;
  background: rgba(22, 33, 48, 0.95);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  z-index: 200;
  font-size: 13px;
  font-weight: 600;
  animation: toastSlideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

/* Inventory Styles */
.inventory-area {
  display: flex;
  flex-direction: column;
}

.inventory-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.inventory-stat {
  padding: 10px 12px;
  border-radius: 11px;
  background: var(--card2);
  border: 1px solid rgba(255, 255, 255, 0.04);
}

.inventory-stat .info-label {
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  margin-bottom: 4px;
  text-transform: uppercase;
}

.inventory-stat .info-value {
  font-size: 14px;
  font-weight: 700;
}

.bar {
  width: 100%;
  height: 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  margin-top: 6px;
}

.bar > span, .bar>span {
  display: block;
  height: 100%;
  width: 0;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.health-bar > span, .health-bar>span {
  background: linear-gradient(90deg, #ff453a, #ff6961);
  box-shadow: 0 0 10px rgba(255, 69, 58, 0.5);
}

.hunger-bar > span, .hunger-bar>span {
  background: linear-gradient(90deg, #e69d00, #ffd60a);
  box-shadow: 0 0 10px rgba(255, 214, 10, 0.5);
}

.equipment-row {
  display: grid;
  grid-template-columns: repeat(5, minmax(60px, 1fr));
  gap: 8px;
  margin: 8px 0 14px;
}

.equipment-slot {
  min-height: 64px;
  padding: 8px 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: rgba(11, 17, 24, 0.85);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
  text-align: center;
  font-size: 10px;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.equipment-slot .equip-label, .equip-label {
  font-size: 8px;
  color: var(--muted);
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 5px;
}

.equipment-slot.dragover {
  border-color: var(--green);
  background: rgba(16, 35, 24, 0.9);
  box-shadow: 0 0 12px var(--green-glow);
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}

.inventory-slot {
  min-width: 0;
  min-height: 60px;
  padding: 6px 4px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: rgba(11, 17, 24, 0.85);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  cursor: pointer;
  overflow: hidden;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
}

.inventory-slot:hover {
  border-color: var(--blue);
  transform: translateY(-2px);
  box-shadow: 0 5px 12px rgba(0, 0, 0, 0.4), inset 0 1px 3px rgba(255, 255, 255, 0.08);
}

.inventory-slot:active, .inventory-slot.active {
  transform: scale(0.96);
}

.inventory-slot.empty {
  opacity: 0.6;
}

.inventory-slot.selected {
  border-color: var(--green);
  box-shadow: 0 0 12px var(--green-glow), inset 0 0 6px rgba(48, 209, 88, 0.3);
  background: rgba(16, 33, 23, 0.85);
}

.inventory-slot.dragover, .inventory-slot.selected.dragover {
  border-color: var(--blue);
  background: rgba(18, 38, 58, 0.85);
  box-shadow: 0 0 12px var(--blue-glow);
}

.slot-index {
  color: var(--muted);
  font-size: 8px;
  font-weight: 600;
  margin-bottom: 3px;
}

.slot-name {
  font-size: 8px;
  font-weight: 700;
  line-height: 1.2;
  word-break: break-word;
}

.slot-count {
  font-size: 10px;
  font-weight: 800;
  margin-top: 3px;
  color: #fff;
}

.drop-zone {
  margin-top: 14px;
  min-height: 50px;
  border: 2px dashed rgba(255, 255, 255, 0.15);
  border-radius: 11px;
  background: rgba(11, 17, 24, 0.5);
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 10px;
  font-size: 12px;
  font-weight: 600;
  transition: all 0.2s;
}

.drop-zone.dragover {
  border-color: var(--red);
  background: rgba(45, 18, 20, 0.8);
  color: var(--text);
  box-shadow: 0 0 14px var(--red-glow);
}

.position-value, .revision {
  font-variant-numeric: tabular-nums;
}

.inventory-list {
  display: grid;
  gap: 6px;
}

.inventory-item-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--card2);
}

.inventory-item-name {
  font-size: 12px;
  font-weight: 600;
}

/* Settings & Schedules */
.setting-list {
  display: grid;
  gap: 8px;
  margin-bottom: 14px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.025);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s;
}

.check-row:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.1);
}

.check-row input {
  width: auto;
  accent-color: var(--blue);
  cursor: pointer;
}

.schedule-list {
  display: grid;
  gap: 8px;
  margin: 10px 0;
}

.schedule-row {
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 11px;
  background: linear-gradient(180deg, rgba(21, 31, 41, 0.85) 0%, rgba(17, 26, 34, 0.85) 100%);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  transition: border-color 0.18s, opacity 0.18s, transform 0.18s;
}

.schedule-row:hover {
  border-color: rgba(77, 163, 255, 0.45);
}

.schedule-row.dragging {
  opacity: 0.5;
  transform: scale(0.98);
}

.schedule-row-top {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
}

.schedule-handle {
  width: 26px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  cursor: grab;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.03);
  user-select: none;
}

.schedule-handle:active {
  cursor: grabbing;
}

.schedule-row-title {
  font-size: 12px;
  font-weight: 800;
  min-width: 0;
}

.schedule-inline {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
  flex-wrap: wrap;
}

.schedule-inline input, .schedule-inline select {
  padding: 7px 9px;
  border-radius: 8px;
  font-size: 11px;
  min-width: 0;
}

.schedule-inline .action-select { width: 94px; }
.schedule-inline .time-input { width: 90px; }
.schedule-inline .minutes-input { width: 106px; }

.schedule-row-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: end;
  margin-top: 8px;
}

.schedule-row-main textarea {
  width: 100%;
  min-height: 52px;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 12px;
  resize: vertical;
}

.schedule-row-main .schedule-field, .schedule-field { display: grid; gap: 4px; }
.schedule-row-main .schedule-field > span, .schedule-row-main .schedule-field>span, .schedule-field > span, .schedule-field>span { color: var(--muted); font-size: 10px; font-weight: 600; }
.schedule-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 10px; }

.scheduler-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin: 10px 0 8px;
}

.scheduler-mode-box {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 220px;
}

.scheduler-mode-box > span, .scheduler-mode-box>span { color: var(--muted); font-size: 11px; font-weight: 600; }
.scheduler-mode-box select { padding: 8px 10px; border-radius: 9px; font-size: 12px; }
.scheduler-note { margin: 6px 0 10px; color: var(--muted); font-size: 10px; line-height: 1.5; }
.compact-save { margin-top: 8px; }
.hidden-field { display: none !important; }

.credential-list {
  display: grid;
  gap: 10px;
  max-height: 60vh;
  overflow: auto;
}

.credential-card {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card2);
}

.credential-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  margin-top: 8px;
}

.credential-value {
  padding: 10px;
  border-radius: 8px;
  background: rgba(10, 16, 24, 0.85);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  word-break: break-all;
  font-size: 12px;
}

.dragging { opacity: 0.55; }
.app-footer {
  margin-top: 24px;
  text-align: center;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
  opacity: 0.85;
}

.hidden { display: none !important; }

/* Custom Scrollbars */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.2); border-radius: 4px; }
::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); }

@media (max-width: 900px) {
  .bot-grid { grid-template-columns: 1fr; }
  .grid { grid-template-columns: 1fr; }
}

@media (max-width: 520px) {
  .info, .inventory-grid { grid-template-columns: 1fr; }
  .equipment-row { grid-template-columns: repeat(5, minmax(48px, 1fr)); }
}

.vip-pill {
  font-size: 11px;
  font-weight: 800;
  padding: 4px 10px;
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.22) 0%, rgba(217, 119, 6, 0.3) 100%);
  border: 1px solid rgba(245, 158, 11, 0.45);
  color: #fbbf24;
  letter-spacing: 0.05em;
  box-shadow: 0 0 12px rgba(245, 158, 11, 0.2);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.platform-pill {
  font-size: 11px;
  font-weight: 750;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(6, 182, 212, 0.15);
  border: 1px solid rgba(6, 182, 212, 0.4);
  color: #38bdf8;
  letter-spacing: 0.04em;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.ram-pill {
  font-size: 11px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.35);
  color: #34d399;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.password-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}
.password-input-wrap input {
  padding-right: 42px !important;
  width: 100%;
  box-sizing: border-box;
}
.password-toggle-btn {
  position: absolute;
  right: 8px;
  background: transparent !important;
  border: none !important;
  color: #94a3b8 !important;
  padding: 4px 6px !important;
  cursor: pointer;
  box-shadow: none !important;
  font-size: 14px;
}
.hidden { display: none !important; }
</style>
</head>

<body>
  <!-- LOGIN GATE OVERLAY -->
  <div id="loginGateOverlay" style="display:flex; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(6, 11, 22, 0.96); z-index:99999; backdrop-filter:blur(14px); align-items:center; justify-content:center; padding:16px;">
    <div style="background:linear-gradient(145deg, #101a33 0%, #0a1122 100%); border:1px solid rgba(56, 189, 248, 0.3); border-radius:18px; width:100%; max-width:420px; padding:30px 24px; box-shadow:0 25px 60px rgba(0,0,0,0.8), 0 0 35px rgba(16, 185, 129, 0.15); text-align:center;">
      <div style="font-size:38px; margin-bottom:8px; filter:drop-shadow(0 0 12px rgba(56, 189, 248, 0.5));">🛡️</div>
      <h2 style="margin:0 0 4px 0; color:#f8fafc; font-size:21px; font-weight:850; letter-spacing:-0.01em;">KBOT WORKER V10.0</h2>
      <p style="margin:0 0 16px 0; color:#94a3b8; font-size:12.5px; line-height:1.4;">Cổng Điều Khiển Bot AFK KingMC • Cloud Engine</p>

      <!-- Nút Discord Hỗ Trợ 24/7 -->
      <a href="https://discord.gg/mJWX5Xp3z" target="_blank" rel="noopener noreferrer" style="display:flex; align-items:center; justify-content:center; gap:10px; width:100%; box-sizing:border-box; margin-bottom:18px; padding:11px 14px; background:linear-gradient(135deg, #5865F2 0%, #4752C4 100%); color:#fff; border-radius:10px; text-decoration:none; font-size:12.5px; font-weight:800; box-shadow:0 6px 18px rgba(88, 101, 242, 0.35); transition:all 0.2s;" title="Tham gia Discord Hỗ Trợ 24/7">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
        </svg>
        <span>Gia Nhập Discord Hỗ Trợ 24/7</span>
      </a>

      <div style="text-align:left; margin-bottom:14px;">
        <label style="font-size:11.5px; color:#cbd5e1; font-weight:700; display:block; margin-bottom:4px; letter-spacing:0.3px;">TÀI KHOẢN (Bỏ trống nếu là Admin):</label>
        <input type="text" id="loginUsernameInput" placeholder="Tài khoản khách thuê..." style="width:100%; box-sizing:border-box; background:#080e1c; border:1px solid #1e293b; color:#fff; padding:10px 12px; border-radius:8px; font-size:13.5px; outline:none;" />
      </div>
      <div style="text-align:left; margin-bottom:20px;">
        <label style="font-size:11.5px; color:#cbd5e1; font-weight:700; display:block; margin-bottom:4px; letter-spacing:0.3px;">MẬT KHẨU TRUY CẬP:</label>
        <div class="password-input-wrap">
          <input type="password" id="loginPasswordInput" placeholder="Mật khẩu Admin hoặc Manager..." style="width:100%; box-sizing:border-box; background:#080e1c; border:1px solid #1e293b; color:#fff; padding:10px 12px; border-radius:8px; font-size:13.5px; outline:none;" />
          <button type="button" class="password-toggle-btn" onclick="toggleBotPasswordVisibility('loginPasswordInput', this)">👁</button>
        </div>
      </div>
      <div id="loginErrorMsg" style="display:none; color:#f87171; font-size:12.5px; margin-bottom:14px; padding:9px 12px; background:rgba(239,68,68,0.12); border-radius:8px; border:1px solid rgba(239,68,68,0.35);"></div>
      <button type="button" onclick="submitBotLogin()" style="width:100%; background:linear-gradient(135deg, #10b981 0%, #059669 100%); color:#fff; border:none; padding:12px; border-radius:10px; font-size:14.5px; font-weight:800; cursor:pointer; letter-spacing:0.4px; box-shadow:0 4px 14px rgba(16,185,129,0.35); transition:all 0.2s;">ĐĂNG NHẬP VÀO BOT</button>
      <div style="font-size:11px; color:#64748b; margin:14px 0 0 0; line-height:1.45;">
        • Quản trị viên: Nhập mật khẩu Admin.<br>
        • Khách thuê: Nhập Username &amp; Mật khẩu được Manager phân quyền.
      </div>
    </div>
  </div>


<div id="mainApp" class="app hidden">

<section class="detail active">

  <div class="topbar">

    <div>

      <div
        id="detailTitle"
        class="detail-title"
      >
        ${BOT_LABEL}
      </div>

      <div class="detail-subtitle">Quản lý và điều khiển bot AFK KingMC tự động • KBOT Cloud Edition</div>

    </div>

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span class="vip-pill">👑 KBOT V10.0</span>
      <span class="platform-pill">⚡ ${PLATFORM.toUpperCase()}</span>
      <span class="ram-pill">🧠 RAM: <strong id="topRamUsage">-- MB</strong></span>
      <button id="soundAlertBtn" class="small sound-btn" type="button" onclick="toggleSoundAlert()">🔕 Âm thanh: TẮT</button>
      <button id="botLogoutBtn" class="small danger hidden" type="button" onclick="botLogout()">🚪 Đăng xuất</button>
    </div>

  </div>

  <div class="grid">

    <div class="panel">

      <h3>Trạng thái</h3>

      <div
        id="detailStatus"
        class="big-status"
      ></div>

      <div class="info">

        <div class="info-item copyable" onclick="copyToClipboard(bot?.username, 'Username')" title="Click để copy Username">
          <div class="info-label">
            USERNAME 📋
          </div>

          <div
            id="detailUsername"
            class="info-value"
          >
            -
          </div>
        </div>

        <div class="info-item">
          <div class="info-label">
            SERVER
          </div>

          <div
            id="detailHost"
            class="info-value"
          >
            -
          </div>
        </div>

        <div class="info-item">
          <div class="info-label">
            PING
          </div>

          <div
            id="detailPing"
            class="info-value"
          >
            -
          </div>
        </div>

        <div class="info-item">
          <div class="info-label">
            SERVER TPS ⚡
          </div>

          <div
            id="detailTps"
            class="info-value"
            style="color:var(--green);font-weight:700;"
          >
            20.0
          </div>
        </div>

        <div class="info-item">
          <div class="info-label">
            UPTIME
          </div>

          <div
            id="detailUptime"
            class="info-value"
          >
            0h 0m 0s
          </div>
        </div>

        <div class="info-item">
          <div class="info-label">
            RECONNECTS
          </div>

          <div
            id="detailReconnects"
            class="info-value"
          >
            0
          </div>
        </div>

        <div class="info-item copyable" onclick="copyToClipboard(byId('detailPosition')?.textContent, 'Tọa độ')" title="Click để copy Tọa độ">
          <div class="info-label">
            COORDINATES 📋
          </div>

          <div
            id="detailPosition"
            class="info-value position-value"
          >
            -
          </div>
        </div>

        <div class="info-item">
          <div class="info-label">
            DIMENSION / LOCATION
          </div>

          <div
            id="detailDimension"
            class="info-value"
          >
            -
          </div>
        </div>

        <div class="info-item copyable" onclick="copyToClipboard(bot?.ipAddress, 'IP')" title="Click để copy IP">
          <div class="info-label">
            BOT IP 📋
          </div>

          <div
            id="detailIp"
            class="info-value"
          >
            -
          </div>
        </div>

        <div class="info-item">
          <div class="info-label">
            RAM MÁY HOST 🧠
          </div>

          <div id="detailRamUsage" class="info-value" style="color:var(--green);">-- MB</div>
        </div>

        <div class="info-item">
          <div class="info-label">
            CPU MÁY HOST ⚡
          </div>

          <div id="detailCpuUsage" class="info-value" style="color:#38bdf8;">-- %</div>
        </div>

        <div class="info-item">
          <div class="info-label">
            LƯU LƯỢNG MẠNG 📶
          </div>

          <div id="detailNetUsage" class="info-value" style="color:var(--yellow);">↓ 0 KB/s • ↑ 0 KB/s</div>
        </div>
      </div>

      <div class="controls">

        <button
          id="startButton"
          class="primary"
          onclick="startBot()"
        >
          ▶ Chạy
        </button>

        <button
          id="stopButton"
          class="danger"
          onclick="stopBot()"
        >
          ■ Dừng
        </button>

        <button
          id="restartButton"
          onclick="restartBot()"
        >
          ↻ Chạy lại
        </button>

      </div>

    </div>

    <div class="panel">

      <div class="chat-title-row">
        <h3>Chat</h3>
        <div style="display:flex;align-items:center;gap:7px;">
          <div id="chatRevision" class="revision">revision 0</div>
          <button class="small danger" type="button" onclick="clearChatHistory()">Xóa lịch sử</button>
        </div>
      </div>

      <div
        id="chatLogs"
        class="log chat-log"
      ></div>

      <form
        class="chat-row chat-form"
        onsubmit="sendMessage(event)"
      >

        <input
          id="messageInput"
          autocomplete="off"
          placeholder="Nhập chat hoặc command... (↑↓ lịch sử)"
        >

        <button
          class="primary"
          type="submit"
        >
          Gửi
        </button>

      </form>

      <div class="chip-row">
        <button type="button" class="chip" onclick="quickSendCommand('/menu')">⚡ /menu (Slot 24)</button>
        <button type="button" class="chip" onclick="quickSendCommand('/dn')">🔑 /dn [MK]</button>
        <button type="button" class="chip" onclick="quickSendCommand('/login')">🔓 /login [MK]</button>
        <button type="button" class="chip" onclick="quickSendCommand('/bal')">💵 /bal</button>
        <button type="button" class="chip" onclick="quickSendCommand('/team chat')">🛡️ /team chat</button>
        <button type="button" class="chip" onclick="quickSendCommand('/spawn')">🏠 /spawn</button>
        <button type="button" class="chip" onclick="quickSendCommand('/pay')">💰 /pay</button>
      </div>

      <div class="note">
        Bấm chip để gửi nhanh. Dùng phím ↑ ↓ trong ô nhập để xem lại các lệnh đã gửi.
      </div>

    </div>

    <div class="panel">

      <div class="chat-title-row">
        <h3>Event Log</h3>
        <div style="display:flex;align-items:center;gap:7px;">
          <div id="eventRevision" class="revision">revision 0</div>
          <button class="small" type="button" onclick="exportLogsToFile()">📥 Tải Log</button>
          <button class="small danger" type="button" onclick="clearEventHistory()">Xóa lịch sử</button>
        </div>
      </div>

      <div
        id="logs"
        class="log"
      ></div>

    </div>

    <div class="panel">

      <div class="chat-title-row">
        <h3>Inventory Manager</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <span id="inventoryCapacity" class="capacity-badge">0/36 ô (0%)</span>
          <div id="inventoryRevision" class="revision">revision 0</div>
        </div>
      </div>

      <div class="inventory-grid">

        <div class="inventory-stat">
          <div class="info-label">HEALTH</div>
          <div id="inventoryHealth" class="info-value">20 / 20</div>
          <div class="bar health-bar"><span id="inventoryHealthBar"></span></div>
        </div>

        <div class="inventory-stat">
          <div class="info-label">HUNGER</div>
          <div id="inventoryFood" class="info-value">20 / 20</div>
          <div class="bar hunger-bar"><span id="inventoryFoodBar"></span></div>
        </div>

        <div class="inventory-stat">
          <div class="info-label">GOLDEN APPLE</div>
          <div id="inventoryGoldenApple" class="info-value">0</div>
        </div>

        <div class="inventory-stat">
          <div class="info-label">TOTEM</div>
          <div id="inventoryTotem" class="info-value">0</div>
        </div>

        <div class="inventory-stat">
          <div class="info-label">OFFHAND</div>
          <div id="inventoryOffhand" class="info-value">-</div>
        </div>

        <div class="inventory-stat">
          <div class="info-label">FOOD COUNT</div>
          <div id="inventoryFoodCount" class="info-value">0</div>
        </div>

      </div>

      <div class="info-label">EQUIPMENT / OFFHAND</div>

      <div class="equipment-row">

        <div
          class="equipment-slot"
          data-destination="head"
          draggable="true"
          ondragstart="startEquipmentDrag(event,'head')"
          ondragover="allowDrop(event)"
          ondragleave="clearDragOver(event)"
          ondrop="dropEquip(event,'head')"
          ondblclick="unequipEquipment('head')"
        >
          <div class="equip-label">HEAD</div>
          <div id="equipHead">-</div>
        </div>

        <div
          class="equipment-slot"
          data-destination="torso"
          draggable="true"
          ondragstart="startEquipmentDrag(event,'torso')"
          ondragover="allowDrop(event)"
          ondragleave="clearDragOver(event)"
          ondrop="dropEquip(event,'torso')"
          ondblclick="unequipEquipment('torso')"
        >
          <div class="equip-label">CHEST</div>
          <div id="equipTorso">-</div>
        </div>

        <div
          class="equipment-slot"
          data-destination="legs"
          draggable="true"
          ondragstart="startEquipmentDrag(event,'legs')"
          ondragover="allowDrop(event)"
          ondragleave="clearDragOver(event)"
          ondrop="dropEquip(event,'legs')"
          ondblclick="unequipEquipment('legs')"
        >
          <div class="equip-label">LEGS</div>
          <div id="equipLegs">-</div>
        </div>

        <div
          class="equipment-slot"
          data-destination="feet"
          draggable="true"
          ondragstart="startEquipmentDrag(event,'feet')"
          ondragover="allowDrop(event)"
          ondragleave="clearDragOver(event)"
          ondrop="dropEquip(event,'feet')"
          ondblclick="unequipEquipment('feet')"
        >
          <div class="equip-label">FEET</div>
          <div id="equipFeet">-</div>
        </div>

        <div
          class="equipment-slot"
          data-destination="off-hand"
          draggable="true"
          ondragstart="startEquipmentDrag(event,'off-hand')"
          ondragover="allowDrop(event)"
          ondragleave="clearDragOver(event)"
          ondrop="dropEquip(event,'off-hand')"
          ondblclick="unequipEquipment('off-hand')"
        >
          <div class="equip-label">OFFHAND</div>
          <div id="equipOffhand">-</div>
        </div>

      </div>

      <div class="info-label">INVENTORY 27 SLOTS</div>
      <div id="mainInventory" class="slot-grid inventory-area"></div>

      <div class="info-label" style="margin-top:12px;">HOTBAR 9 SLOTS</div>
      <div id="inventoryHotbar" class="slot-grid inventory-area"></div>

      <div
        id="dropZone"
        class="drop-zone"
        ondragover="allowDrop(event)"
        ondragleave="clearDragOver(event)"
        ondrop="dropItemToWorld(event)"
      >
        Kéo item vào đây để vứt
      </div>

      <div class="note">
        Kéo-thả item để di chuyển. Kéo item vào Head/Chest/Legs/Feet/Offhand để trang bị.
        Click hotbar để chọn slot. Double-click ô trang bị để tháo.
        Inventory được đồng bộ với bot mỗi 1 giây và dùng revision để tránh thao tác trên dữ liệu cũ.
      </div>

    </div>

    <!-- REMOTE GUI INSPECTOR -->
    <div id="remoteGuiCard" class="panel" style="display:none;">
      <div class="chat-title-row">
        <h3 id="remoteGuiTitle">🖥️ GUI Sảnh / Máy Chủ Đang Mở</h3>
        <div class="revision" style="display:flex;align-items:center;gap:8px;">Click ô để tương tác trực tiếp <button type="button" class="small" onclick="closeGuiWindow()">✕ Đóng GUI</button></div>
      </div>
      <div id="remoteGuiSlots" style="display:grid;grid-template-columns:repeat(9, 1fr);gap:4px;margin-top:10px;"></div>
    </div>

    <div id="settingsPanel" class="panel">

      <div class="chat-title-row">
        <h3>Settings</h3>
        <div class="revision">Lưu runtime + file setting</div>
      </div>

      <div class="setting-list">
        <label class="check-row"><input id="settingEcoMode" type="checkbox" onchange="markSettingsDirty()"> <span>🌱 Eco Mode (Tiết kiệm 80% CPU & giữ RAM &lt; 220MB)</span></label>
        <label class="check-row"><input id="settingAutoTotem" type="checkbox" onchange="markSettingsDirty()"> <span>Auto Totem phản xạ tức thì (&lt; 50ms)</span></label>
        <label class="check-row"><input id="settingAntiHungry" type="checkbox" onchange="markSettingsDirty()"> <span>Anti Hungry / Auto Eat</span></label>
        <label class="check-row"><input id="settingAutoReconnect" type="checkbox" onchange="markSettingsDirty()"> <span>Auto Reconnect + tự thử lại LOGIN/DN/MENU</span></label>
        <label class="check-row"><input id="settingAntiAfkKick" type="checkbox" onchange="markSettingsDirty()"> <span>Smart Anti-AFK Kick (Xoay đầu, vung tay nhẹ)</span></label>
      </div>

      <button id="saveSettingsButton" class="primary" type="button" onclick="saveSettings()">Lưu setting</button>
      <div class="note">Tọa độ được quét mỗi 250ms. AFK chỉ được xác nhận khi tọa độ sau click không còn ở LOGIN hoặc LOBBY.</div>

    </div>

    <div id="autoChatPanel" class="panel">

      <div class="chat-title-row">
        <h3>Auto Chat</h3>
        <button class="small primary" type="button" onclick="addAutoChatSchedule()">＋ Thêm</button>
      </div>

      <div id="autoChatSchedules" class="schedule-list"></div>
      <div class="note">Mỗi dòng là một lịch riêng. Kéo ⋮⋮ để đổi thứ tự; sửa trực tiếp rồi bấm Lưu Auto Chat.</div>
      <button id="saveAutoChatButton" class="primary compact-save" type="button" onclick="saveAutoChat()">Lưu Auto Chat</button>

    </div>

    <div id="botSchedulePanel" class="panel">

      <div class="chat-title-row">
        <h3>Hẹn giờ Bot</h3>
        <button class="small primary" type="button" onclick="addBotSchedule()">＋ Thêm</button>
      </div>

      <div class="scheduler-toolbar">
        <label class="scheduler-mode-box">
          <span>Chế độ</span>
          <select id="botScheduleMode" onchange="botScheduleModeChanged(this)">
            <option value="fixed">Giờ cố định mỗi ngày</option>
            <option value="cycle">Chu kỳ theo thứ tự</option>
          </select>
        </label>
        <label class="check-row" style="margin:0;padding:7px 9px;">
          <input id="botScheduleEnabled" type="checkbox" checked>
          <span>Kích hoạt lịch</span>
        </label>
      </div>
      <div id="botScheduleModeNote" class="scheduler-note"></div>
      <div id="botSchedules" class="schedule-list"></div>
      <div class="note">Chỉ có một chế độ tại một thời điểm. Bấm ＋ để thêm dòng. Ở Chu kỳ, thời gian mỗi dòng tính từ dòng ngay phía trên; kéo đổi thứ tự thì cách tính cũng đổi theo.</div>
      <button id="saveBotSchedulesButton" class="primary compact-save" type="button" onclick="saveBotSchedules()">Lưu hẹn giờ Bot</button>

    </div>

    <div class="panel" id="botAccountPanel">

      <h3>Tài khoản</h3>

      <div class="form-row">

        <label>
          Username
        </label>

        <input
          id="usernameInput"
          autocomplete="off"
          placeholder="Username mới (có thể để trống)"
        >

      </div>

      <div class="form-row">

        <label>
          Password
        </label>

        <div class="password-input-wrap">
          <input
            id="passwordInput"
            type="password"
            autocomplete="new-password" spellcheck="false"
            placeholder="Password mới (có thể để trống)"
          >
          <button type="button" class="password-toggle-btn" onclick="toggleBotPasswordVisibility('passwordInput', this)">👁</button>
        </div>

      </div>

      <button
        class="primary"
        onclick="saveAccount()"
      >
        Lưu thay đổi
      </button>

      <div class="note">
        Có thể đổi username hoặc password riêng lẻ.
        Bấm "Chạy lại" để áp dụng tài khoản mới.
        Khi service khởi động lại, bot sẽ dùng username/password trong BOT_CONFIG để tự kết nối lại.
      </div>

    </div>

    <!-- PANEL GẮN PROXY RIÊNG CỦA BOT -->
    <div class="panel" id="botProxyPanel">
      <div class="chat-title-row">
        <h3>🌐 Cấu hình Proxy</h3>
        <span id="botProxyBadge" class="capacity-badge" style="background:var(--border);color:var(--muted);">TẮT</span>
      </div>
      <div class="setting-list" style="margin-bottom:12px;">
        <label class="check-row">
          <input id="proxyEnabledInput" type="checkbox">
          <span>Kích hoạt Proxy khi kết nối Minecraft</span>
        </label>
      </div>
      <div class="form-row">
        <label>Giao thức (Protocol)</label>
        <select id="proxyProtocolInput" style="width:100%;box-sizing:border-box;">
          <option value="socks5">SOCKS5 (Khuyên dùng - Nhanh & Ẩn danh)</option>
          <option value="http">HTTP / HTTPS CONNECT Proxy</option>
          <option value="socks4">SOCKS4</option>
        </select>
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px;">
        <div class="form-row">
          <label>Host / IP Proxy</label>
          <input id="proxyHostInput" placeholder="vd: 103.152.112.5" autocomplete="off">
        </div>
        <div class="form-row">
          <label>Port</label>
          <input id="proxyPortInput" type="number" placeholder="1080" min="1" max="65535">
        </div>
      </div>
      <div class="form-row">
        <label>Username (nếu có)</label>
        <input id="proxyUsernameInput" placeholder="Để trống nếu không có auth" autocomplete="off">
      </div>
      <div class="form-row">
        <label>Password (nếu có)</label>
        <div class="password-input-wrap">
          <input id="proxyPasswordInput" type="password" autocomplete="new-password" placeholder="Mật khẩu proxy...">
          <button type="button" class="password-toggle-btn" onclick="toggleBotPasswordVisibility('proxyPasswordInput', this)">👁</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap;">
        <button class="primary" onclick="saveBotProxy()">💾 Lưu Proxy</button>
        <button class="small" onclick="testBotProxy()" id="botProxyTestBtn">🧪 Kiểm Tra Kết Nối</button>
        <button class="small danger" onclick="clearBotProxy()" style="margin-left:auto;">✕ Xóa Proxy</button>
      </div>
      <div id="botProxyTestResult" class="note" style="margin-top:8px;">
        Proxy có thể dùng chung giữa các bot. Hỗ trợ SOCKS5 & HTTP. Khi bật, bot sẽ định tuyến qua Proxy này để đổi IP an toàn.
      </div>
    </div>

  </div>

</section>

</div>

<div class="app-footer">
  <div class="bot-release-card" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;width:100%;">
    <div>
      <strong>KBOT Worker V11.6</strong> • Commercial Enterprise Fleet • Pure Render Cloud Engine.
    </div>
    <button type="button" class="small bot-release-btn" onclick="openBotUpdateModal()">📜 Chi tiết</button>
  </div>
</div>

<div id="botUpdateModal" class="modal hidden">
  <div class="modal-card" style="max-width:620px; max-height:85vh; display:flex; flex-direction:column;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <h3 style="margin:0;font-size:18px;">📜 Lịch Sử Phát Triển KBOT Worker (V1.0 - V11.6)</h3>
      <button class="small" type="button" onclick="closeBotUpdateModal()">✕</button>
    </div>
    <div style="max-height:calc(85vh - 120px);overflow-y:auto;font-size:12.5px;line-height:1.6;color:var(--text);padding-right:8px;">
      <!-- V11.6 -->
      <div style="margin-bottom:16px;border-left:3px solid #eab308;padding-left:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <strong style="color:#eab308;font-size:13.5px;">👑 V11.6 KBOT Commercial Enterprise Edition (Performance & Experience Evolution)</strong>
          <span style="background:rgba(234,179,8,0.2);color:#eab308;border:1px solid rgba(234,179,8,0.4);border-radius:4px;font-size:9.5px;font-weight:800;padding:2px 6px;">LATEST</span>
        </div>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Tối ưu hóa luồng xử lý Minecraft và kết nối mạng, giảm tải CPU/RAM, phản hồi thao tác điều khiển mượt mà tức thì.</li>
          <li>Cải tiến cơ chế tự động kết nối lại (Auto-Reconnect) khi server bảo trì hoặc rớt mạng, đảm bảo bot duy trì AFK liên tục 24/7 với Uptime 99.9%.</li>
          <li>Đồng bộ tức thời hạn sử dụng và trạng thái tài khoản khách thuê, duy trì phiên AFK an toàn và ổn định.</li>
        </ul>
      </div>

      <!-- V11.5 -->
      <div style="margin-bottom:16px;border-left:3px solid #38bdf8;padding-left:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <strong style="color:#38bdf8;font-size:13.5px;">👑 V11.5 KBOT Commercial Enterprise Edition (Full SaaS Fleet)</strong>
        </div>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Tự động nhận diện và đồng bộ 100% dữ liệu tài khoản tự đăng ký mới từ Manager qua cơ chế <code>bot_auth_cache.json</code> mã hóa an toàn.</li>
          <li>Đồng bộ phân quyền độc quyền 1-Bot-1-User: Thu hồi phiên ngay lập tức khi bot được hủy hoặc chuyển giao cho khách thuê mới.</li>
          <li>Tương thích toàn diện với chính sách gia hạn linh hoạt và tài khoản VIP Vĩnh Viễn.</li>
          <li>Giảm tải tối đa tài nguyên Render (CPU idle &lt; 2%, RAM ổn định ~120MB - 180MB) với chu kỳ dọn dẹp bộ nhớ và culling chunks thông minh.</li>
        </ul>
      </div>

      <!-- V11.4 -->
      <div style="margin-bottom:16px;border-left:3px solid #38bdf8;padding-left:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <strong style="color:#38bdf8;font-size:13.5px;">🚀 V11.4 KBOT Cloud Native Edition (Persistence & Fleet Sync)</strong>
        </div>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Khóa xác thực dịch vụ <code>BOT_SECRET_KEY</code> đồng bộ plug-and-play, tương thích 100% mọi luồng kết nối từ Manager.</li>
          <li>Đồng bộ tức thời tài khoản khách thuê, phân quyền đổi mật khẩu Minecraft và phiên làm việc theo thời gian thực.</li>
          <li>Tối ưu hóa sâu phần cứng & băng thông: giảm chu kỳ CPU không tải, điều tiết polling 500ms khi hoạt động và 5000ms khi ẩn tab.</li>
          <li>Giới hạn dung lượng RAM mảng nhật ký và chat logs dưới 180MB, hoàn hảo cho gói miễn phí/cơ bản của Render.</li>
        </ul>
      </div>

      <!-- V11.3 -->
      <div style="margin-bottom:16px;border-left:3px solid #10b981;padding-left:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <strong style="color:#34d399;font-size:13.5px;">🛡️ V11.3 KBOT Cloud Native Edition (Pure Render Optimized)</strong>
        </div>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Tối ưu hóa độc quyền cho Render Web Service, nhận diện PORT 10000 fallback, thanh trừng toàn bộ logic nền tảng cũ.</li>
          <li>Thu hồi phiên đăng nhập tức thì (Real-time Session Revocation) khi tài khoản đổi mật khẩu hoặc bị vô hiệu hóa trên Manager.</li>
          <li>Cập nhật thời hạn cookie phiên đăng nhập đồng bộ chuẩn 24 giờ (86400s).</li>
          <li>Lưu trữ nguyên tử an toàn cho endpoint reset bàn giao khách và cấu hình lịch trình bot-schedules.</li>
          <li>Cơ chế snapshot revision checking giảm thiểu 90% băng thông và tải CPU khi bot đang AFK ổn định.</li>
          <li>Khắc phục triệt để lỗi báo động còi giả khi chủ động dừng/khởi động lại bot từ Web UI.</li>
        </ul>
      </div>

      <!-- V10.0 -->
      <div style="margin-bottom:16px;border-left:3px solid #38bdf8;padding-left:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <strong style="color:#38bdf8;font-size:13px;">🚀 V10.0 KBOT Commercial Pro (16.10.2026)</strong>
        </div>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Nâng cấp thương hiệu thương mại KBOT Worker, tối ưu hóa toàn diện cho người thuê bot KingMC.</li>
          <li>Tích hợp nút kết nối cộng đồng Discord hỗ trợ kỹ thuật và mua key 24/7.</li>
          <li>Đồng bộ đa máy chủ (Multi-Host Sync) Real-Time 500ms giữa Manager và Bot Worker.</li>
        </ul>
      </div>

      <!-- V9.3 -->
      <div style="margin-bottom:16px;border-left:3px solid #38bdf8;padding-left:12px;">
        <strong style="color:#38bdf8;font-size:13px;">🛡️ V9.3 Real-Time & Security (15.10.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Khóa nội bộ Service-to-Service (<code>BOT_SECRET_KEY</code>) ngăn chặn 100% can thiệp trái phép.</li>
          <li>Đồng bộ tài khoản khách thuê an toàn từ Manager bằng chuẩn mã hóa scrypt qua <code>bot_auth_cache.json</code>.</li>
          <li>Bảo vệ Login Gate chống lộ thông tin khi F5; thêm nút Đăng xuất trên topbar.</li>
          <li>Nút con mắt (👁 / 🙈) ẩn/hiện mật khẩu ingame và chip lệnh nhanh (/dn, /login, /pay) không auto-send.</li>
          <li>Reset bàn giao khách mới làm sạch 100% RAM và file, không hồi sinh credentials.</li>
        </ul>
      </div>

      <!-- V8.2 -->
      <div style="margin-bottom:16px;border-left:3px solid #94a3b8;padding-left:12px;">
        <strong style="color:#cbd5e1;font-size:13px;">🌱 V8.2 Eco Sentinel (12.10.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Chế độ Siêu Tiết Kiệm Eco: giảm 80% CPU & giữ RAM dưới 220MB khi AFK tĩnh.</li>
          <li>Bộ đo phần cứng RAM/CPU chuẩn Container cgroups.</li>
          <li>Bộ dọn rác thực thể Farm (Farm Item Entity Pruner) chống tràn 512MB RAM.</li>
        </ul>
      </div>

      <!-- V7.0 -->
      <div style="margin-bottom:16px;border-left:3px solid #94a3b8;padding-left:12px;">
        <strong style="color:#cbd5e1;font-size:13px;">👑 V7.0 Multi-Tenant RBAC & License Key (08.10.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Hệ thống phân quyền Admin/User; bảo vệ thông tin tài khoản bot trước khách thuê.</li>
          <li>Khóa chống brute-force đăng nhập; quản lý Giftcode gia hạn tự động.</li>
        </ul>
      </div>

      <!-- V6.1 -->
      <div style="margin-bottom:16px;border-left:3px solid #94a3b8;padding-left:12px;">
        <strong style="color:#cbd5e1;font-size:13px;">⚡ V6.1 (V6.0) Smart Watchdog & Auto-Healing (02.10.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Tự động nhận diện tọa độ AUTH (5, 119, 4) và LOBBY (1, 41, 1), tự click slot 24 vào server cày cuốc.</li>
          <li>Auto Totem tay phụ khi máu &le; 5 tim; Auto Ăn khi đói; Watchdog chống kẹt sảnh quá 28s.</li>
        </ul>
      </div>

      <!-- V5.0 -->
      <div style="margin-bottom:16px;border-left:3px solid #94a3b8;padding-left:12px;">
        <strong style="color:#cbd5e1;font-size:13px;">🎒 V5.0 Remote Inventory Virtualization (25.09.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Quản lý hòm đồ 36 ô ảo từ xa, kéo thả trang bị, vứt đồ ra thế giới, theo dõi máu/đói.</li>
        </ul>
      </div>

      <!-- V4.0 -->
      <div style="margin-bottom:16px;border-left:3px solid #94a3b8;padding-left:12px;">
        <strong style="color:#cbd5e1;font-size:13px;">⏰ V4.0 Dual-Engine Task Scheduler (18.09.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Hẹn giờ bật/tắt bot theo giờ cố định hoặc chu kỳ lặp; hàng đợi Auto Chat rao bán shop thông minh.</li>
        </ul>
      </div>

      <!-- V3.0 -->
      <div style="margin-bottom:16px;border-left:3px solid #94a3b8;padding-left:12px;">
        <strong style="color:#cbd5e1;font-size:13px;">🔔 V3.0 Webhook Telemetry (10.09.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Tích hợp Webhook Discord & Telegram thông báo tức thời khi chết, mất mạng, sắp hết Totem.</li>
        </ul>
      </div>

      <!-- V2.0 -->
      <div style="margin-bottom:16px;border-left:3px solid #94a3b8;padding-left:12px;">
        <strong style="color:#cbd5e1;font-size:13px;">🌐 V2.0 (V2.1) Multi-Bot Cluster (01.09.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Quản lý hạm đội bot tập trung, thống kê KPI và điều khiển hàng loạt.</li>
        </ul>
      </div>

      <!-- V1.0 -->
      <div style="margin-bottom:10px;border-left:3px solid #94a3b8;padding-left:12px;">
        <strong style="color:#cbd5e1;font-size:13px;">🚀 V1.0 Genesis Worker (15.08.2026)</strong>
        <ul style="margin:4px 0 0 16px;padding:0;">
          <li>Khởi tạo worker bot Mineflayer kết nối KingMC và Web UI điều khiển độc lập.</li>
        </ul>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);">
      <button class="primary" type="button" onclick="closeBotUpdateModal()">Đã hiểu</button>
    </div>
  </div>
</div>

<div
  id="toast"
  class="toast"
></div>


<script>
'use strict';

let bot = null;
let inventory = null;
let autoChatSchedules = [];
let botSchedules = [];
let lastLogRevision = -1;
let lastChatRevision = -1;
let uptimeSyncAt = Date.now();

let draggedSlot = null;
let inventoryActionInFlight = false;
let refreshInFlight = false;
let refreshQueued = false;
let actionRequestInFlight = false;
let settingsDirty = false;
let settingsSaveInFlight = false;
let autoChatDirty = false;
let autoChatSaveInFlight = false;
let botScheduleDirty = false;
let botScheduleSaveInFlight = false;
let refreshGeneration = 0;

function byId(id) {
  return document.getElementById(id);
}


function invalidatePendingReads() {
  refreshGeneration++;
  return refreshGeneration;
}

function renderPublicIp() {
  const element = byId('detailIp');
  if (element) element.textContent = bot?.ipAddress || '-';
}

function renderSettings() {
  if (!bot) return;
  renderPublicSettings({ settings: bot.settings || {} });
}

function runQueuedRefresh() {
  if (
    refreshQueued &&
    !refreshInFlight &&
    !actionRequestInFlight &&
    !inventoryActionInFlight &&
    !settingsSaveInFlight &&
    !autoChatSaveInFlight &&
    !botScheduleSaveInFlight
  ) {
    refreshQueued = false;
    void refresh(true);
  }
}


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message) {
  const toast = byId('toast');
  if (!toast) return;

  toast.textContent = String(message || 'Đã xử lý.');
  toast.style.display = 'block';

  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(function() {
    toast.style.display = 'none';
  }, 2600);
}

async function apiJson(url, options) {
  const original = options || {};
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(Number(original.timeoutMs))
    ? Math.max(1000, Math.min(30000, Number(original.timeoutMs)))
    : 15000;
  const timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  const headers = { ...(original.headers || {}) };
  const requestOptions = {
    cache: 'no-store',
    credentials: 'same-origin',
    ...original,
    headers,
    signal: original.signal || controller.signal
  };
  delete requestOptions.timeoutMs;

  try {
    const response = await fetch(url, requestOptions);
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); }
      catch (_) { data = { raw: text }; }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: {
        error: err && err.name === 'AbortError'
          ? 'Request web quá thời gian chờ.'
          : (err.message || 'Không thể kết nối server web.')
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

function statusMeta(status, available, manuallyStopped = false) {
  if (!available) return ['red', 'OFFLINE / KHÔNG KẾT NỐI'];
  if (manuallyStopped && (status === 'offline' || status === 'kicked' || status === 'stopped')) {
    return ['gray', 'ĐÃ DỪNG THỦ CÔNG'];
  }
  switch (status) {
    case 'afk': return ['green', 'AFK'];
    case 'online': return ['blue', 'ONLINE'];
    case 'connecting': return ['yellow', 'ĐANG KẾT NỐI'];
    case 'authenticating': return ['yellow', 'ĐANG ĐĂNG NHẬP'];
    case 'entering': return ['yellow', 'ĐANG VÀO AFK'];
    case 'kicked': return ['red', 'BỊ KICK'];
    case 'offline':
    default: return ['red', 'OFFLINE'];
  }
}

function renderDimensionLocation() {
  const element = byId('detailDimension');
  if (!element) return;

  const dimension = bot && bot.dimension ? String(bot.dimension) : '-';
  const location = String(bot && bot.locationState || '').toLowerCase();
  const position = bot && bot.roundedLocation;

  let locationLabel = '';
  if (location === 'login') locationLabel = 'LOGIN';
  else if (location === 'lobby') locationLabel = 'LOBBY';
  else if (location === 'other') locationLabel = 'OTHER';

  if (position && Number.isFinite(Number(position.x)) &&
      Number.isFinite(Number(position.y)) &&
      Number.isFinite(Number(position.z))) {
    const coord = '(' +
      Math.round(Number(position.x)) + ' ' +
      Math.round(Number(position.y)) + ' ' +
      Math.round(Number(position.z)) + ')';

    if (locationLabel) {
      element.textContent = dimension + ' • ' + locationLabel + ' ' + coord;
    } else {
      element.textContent = dimension + ' • ' + coord;
    }
    return;
  }

  element.textContent = locationLabel
    ? dimension + ' • ' + locationLabel
    : dimension;
}

let manualStopRequested = false;

function renderBotState() {
  if (!bot) return;
  if (lastKnownBotStatus && lastKnownBotStatus !== bot.status) {
    if ((bot.status === 'offline' || bot.status === 'kicked') && !bot.manuallyStopped && !manualStopRequested) {
      playAlertTone('danger');
    }
  }
  if (bot.status !== 'offline' && bot.status !== 'kicked') {
    manualStopRequested = false;
  }
  lastKnownBotStatus = bot.status;

  const statusInfo = statusMeta(bot.status, bot.available !== false, !!bot.manuallyStopped);
  const status = byId('detailStatus');
  if (status) {
    status.innerHTML =
      '<span class="dot ' + statusInfo[0] + '"></span>' +
      escapeHtml(statusInfo[1]);
  }

  const title = byId('detailTitle');
  if (title) title.textContent = bot.label || 'KingMC Bot';

  const username = byId('detailUsername');
  if (username) username.textContent = bot.username || 'Chưa đặt';

  const host = byId('detailHost');
  if (host) {
    host.textContent = bot.host
      ? String(bot.host) + ':' + String(bot.port ?? '')
      : '-';
  }

  const ping = byId('detailPing');
  if (ping) ping.textContent =
    bot.ping == null ? '--' : String(bot.ping) + ' ms';

  const tpsEl = byId('detailTps');
  if (tpsEl) {
    const tpsVal = Number(bot.tps ?? bot.serverTps ?? 20.0);
    tpsEl.textContent = tpsVal.toFixed(1);
    tpsEl.style.color = tpsVal >= 18.5 ? 'var(--green)' : (tpsVal >= 14.0 ? 'var(--yellow)' : 'var(--red)');
  }

  const reconnects = byId('detailReconnects');
  if (reconnects) reconnects.textContent = String(bot.reconnectCount || 0);

  const position = byId('detailPosition');
  const p = bot.position;

  if (position) {
    position.textContent =
      p && Number.isFinite(Number(p.x)) &&
      Number.isFinite(Number(p.y)) &&
      Number.isFinite(Number(p.z))
        ? Math.round(Number(p.x)) + ' ' +
          Math.round(Number(p.y)) + ' ' +
          Math.round(Number(p.z))
        : '-';
  }

  const ip = byId('detailIp');
  if (ip) ip.textContent = bot.ipAddress || '-';

  const topRam = byId('topRamUsage');
  const cardRam = byId('detailRamUsage');
  const cardCpu = byId('detailCpuUsage');
  const cardNet = byId('detailNetUsage');
  const hw = bot.hostHardware || bot.system;

  if (hw && hw.ramTotalMb > 0) {
    if (topRam) {
      topRam.textContent = hw.ramUsedMb + '/' + hw.ramTotalMb + ' MB (' + hw.ramPercent + '%)';
    }
    if (cardRam) {
      cardRam.textContent = hw.ramUsedMb + ' / ' + hw.ramTotalMb + ' MB (' + hw.ramPercent + '%) [Bot: ' + hw.botRssMb + ' MB]';
      cardRam.style.color = hw.ramPercent > 85 ? 'var(--red)' : hw.ramPercent > 70 ? 'var(--yellow)' : 'var(--green)';
    }
    if (cardCpu) {
      cardCpu.textContent = hw.cpuPercent + '% / ' + hw.cpuCores + ' Cores';
      cardCpu.style.color = hw.cpuPercent > 85 ? 'var(--red)' : hw.cpuPercent > 60 ? 'var(--yellow)' : '#38bdf8';
    }
    if (cardNet) {
      cardNet.textContent = '↓ ' + hw.netDownKb + ' KB/s • ↑ ' + hw.netUpKb + ' KB/s (Tổng: ' + hw.netTotalRxMb + ' MB)';
    }
  } else {
    const ram = Number(bot.ramRssMb || bot.ramRss || bot.rssMb || bot.memory?.rssMb || 0);
    const heap = Number(bot.ramHeap || bot.heapMb || bot.memory?.heapMb || 0);
    if (topRam && ram > 0) {
      topRam.textContent = ram + ' MB';
    }
    if (cardRam) {
      cardRam.textContent = ram > 0 ? (ram + ' MB' + (heap > 0 ? ' (Heap ' + heap + ' MB)' : '')) : '-- MB';
      cardRam.style.color = ram > 380 ? 'var(--red)' : ram > 280 ? 'var(--yellow)' : 'var(--green)';
    }
  }

  renderDimensionLocation();
}

function renderPublicSettings(settingsData) {
  if (!settingsData) return;

  // Hỗ trợ cả 2 dạng: { settings: { ... } } (từ POST /api/settings)
  // và { autoTotem: ... } trực tiếp (từ GET /api/snapshot result.data.settings)
  const settings = (settingsData.settings && typeof settingsData.settings === 'object')
    ? settingsData.settings
    : (typeof settingsData === 'object' ? settingsData : {});

  const ecoMode = byId('settingEcoMode');
  const autoTotem = byId('settingAutoTotem');
  const antiHungry = byId('settingAntiHungry');
  const autoReconnect = byId('settingAutoReconnect');
  const antiAfkKick = byId('settingAntiAfkKick');

  if (ecoMode) ecoMode.checked = settings.ecoMode !== false;
  if (autoTotem) autoTotem.checked = settings.autoTotem !== false;
  if (antiHungry) antiHungry.checked = settings.antiHungry !== false;
  if (autoReconnect) autoReconnect.checked = settings.autoReconnect !== false;
  if (antiAfkKick) antiAfkKick.checked = settings.antiAfkKick !== false;
  if (settings.proxy) renderBotProxy(settings.proxy);
}

function clampClientNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeScheduleForClient(schedule, index) {
  const raw = schedule && typeof schedule === 'object' ? schedule : {};
  const mode = raw.mode === 'fixed' ? 'fixed' : 'interval';
  return {
    id: String(raw.id || (Date.now() + '-' + index)),
    enabled: raw.enabled !== false,
    mode,
    intervalSeconds: clampClientNumber(raw.intervalSeconds, 3600, 10, 604800),
    times: Array.isArray(raw.times) ? raw.times.map(function(value) { return String(value || '').trim(); }).filter(Boolean) : [],
    messages: Array.isArray(raw.messages) ? raw.messages.map(function(value) { return String(value || '').trim(); }).filter(Boolean) : [],
    messageDelaySeconds: clampClientNumber(raw.messageDelaySeconds, 2, 0, 3600)
  };
}

function renderAutoChatSchedules(schedules) {
  const box = byId('autoChatSchedules');
  if (!box) return;
  const list = Array.isArray(schedules) ? schedules.map(normalizeScheduleForClient) : [];
  autoChatSchedules = list;

  if (!list.length) {
    box.innerHTML = '<div class="note">Chưa có lịch Auto Chat. Bấm “＋ Thêm” để tạo.</div>';
    return;
  }

  box.innerHTML = list.map(function(schedule, index) {
    const checked = schedule.enabled ? ' checked' : '';
    const fixed = schedule.mode === 'fixed';
    return '' +
      '<div class="schedule-row" draggable="true" data-index="' + index + '" data-id="' + escapeHtml(schedule.id) + '"' +
        ' ondragstart="dragAutoChatSchedule(event,' + index + ')" ondragover="allowAutoChatDrop(event)" ondrop="dropAutoChatSchedule(event,' + index + ')" ondragend="endScheduleDrag(this)">' +
        '<div class="schedule-row-top">' +
          '<div class="schedule-handle" title="Kéo để sắp xếp">⋮⋮</div>' +
          '<div class="schedule-row-title">Lịch #' + (index + 1) + '</div>' +
          '<label class="check-row" style="margin:0;padding:5px 7px;"><input data-field="enabled" type="checkbox"' + checked + '> <span>Bật</span></label>' +
          '<button class="small danger" type="button" onclick="removeAutoChatSchedule(' + index + ')">Xóa</button>' +
        '</div>' +
        '<div class="schedule-inline" style="margin-top:7px;flex-wrap:wrap;">' +
          '<select data-field="mode" onchange="scheduleModeChanged(this)">' +
            '<option value="interval"' + (!fixed ? ' selected' : '') + '>Lặp lại</option>' +
            '<option value="fixed"' + (fixed ? ' selected' : '') + '>Giờ cố định</option>' +
          '</select>' +
          (fixed
            ? '<input data-field="times" class="time-input" style="width:min(100%,280px);" value="' + escapeHtml(schedule.times.join(', ')) + '" placeholder="08:00, 12:00, 18:00">'
            : '<input data-field="intervalSeconds" class="minutes-input" type="number" min="10" max="604800" value="' + schedule.intervalSeconds + '" title="Khoảng lặp (giây)">') +
          '<input data-field="messageDelaySeconds" class="minutes-input" type="number" min="0" max="3600" value="' + schedule.messageDelaySeconds + '" title="Delay giữa các tin (giây)">' +
          '<span class="schedule-meta">Delay tin (s)</span>' +
        '</div>' +
        '<div class="schedule-row-main">' +
          '<label class="schedule-field"><span>Tin nhắn — mỗi dòng một tin</span><textarea data-field="messages" placeholder="Tin 1&#10;Tin 2&#10;Tin 3">' + escapeHtml(schedule.messages.join('\n')) + '</textarea></label>' +
          '<div class="schedule-meta" style="padding-bottom:6px;"><span>' + (fixed ? 'Theo giờ' : 'Theo khoảng lặp') + '</span></div>' +
        '</div>' +
      '</div>';
  }).join('');
}

function markSettingsDirty() { settingsDirty = true; }
function markAutoChatDirty() { autoChatDirty = true; }
function markBotScheduleDirty() { botScheduleDirty = true; }
function defaultFixedTime(index) {
  const hour = (3 + Number(index || 0) * 3) % 24;
  return String(hour).padStart(2, '0') + ':00';
}


function collectAutoChatSchedules() {
  const box = byId('autoChatSchedules');
  if (!box) return [];
  return Array.from(box.querySelectorAll('.schedule-row')).map(function(row, index) {
    const get = field => row.querySelector('[data-field="' + field + '"]');
    const mode = get('mode') && get('mode').value === 'fixed' ? 'fixed' : 'interval';
    const id = row.dataset.id || (autoChatSchedules[index] && autoChatSchedules[index].id) || (Date.now() + '-' + index);
    row.dataset.id = id;
    const messages = String(get('messages') ? get('messages').value : '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    let intervalSeconds = 3600;
    let times = [];
    if (mode === 'fixed') {
      times = String(get('times') ? get('times').value : '').split(/[,\n]+/).map(v => v.trim()).filter(Boolean);
    } else {
      intervalSeconds = clampClientNumber(get('intervalSeconds') ? get('intervalSeconds').value : 3600, 3600, 10, 604800);
    }
    return {
      id,
      enabled: !!(get('enabled') && get('enabled').checked),
      mode,
      intervalSeconds,
      times,
      messages,
      messageDelaySeconds: clampClientNumber(get('messageDelaySeconds') ? get('messageDelaySeconds').value : 2, 2, 0, 3600)
    };
  });
}

function validateAutoChatSchedules(schedules) {
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (let i = 0; i < schedules.length; i++) {
    const schedule = schedules[i];
    if (!schedule.messages.length) return 'Lịch #' + (i + 1) + ' chưa có tin nhắn.';
    if (schedule.mode === 'fixed') {
      if (!schedule.times.length) return 'Lịch #' + (i + 1) + ' chưa có giờ cố định.';
      for (const value of schedule.times) {
        if (!validTime.test(value)) return 'Lịch #' + (i + 1) + ' có giờ không hợp lệ: ' + value;
      }
    }
  }
  return '';
}

function scheduleModeChanged(select) {
  const current = collectAutoChatSchedules();
  const index = Number(select?.closest('.schedule-row')?.dataset.index ?? -1);
  if (current[index]) {
    if (current[index].mode === 'fixed' && !current[index].times.length) {
      current[index].times = ['08:00'];
    }
    if (current[index].mode === 'interval' && !Number.isFinite(Number(current[index].intervalSeconds))) {
      current[index].intervalSeconds = 3600;
    }
  }
  autoChatDirty = true;
  renderAutoChatSchedules(current);
}

let draggedAutoChatIndex = null;
function dragAutoChatSchedule(event, index) {
  draggedAutoChatIndex = index;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(index));
  event.currentTarget.classList.add('dragging');
}
function allowAutoChatDrop(event) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
function dropAutoChatSchedule(event, targetIndex) {
  event.preventDefault();
  const from = draggedAutoChatIndex;
  draggedAutoChatIndex = null;
  if (!Number.isInteger(from) || from === targetIndex) return;
  const current = collectAutoChatSchedules();
  const [moved] = current.splice(from, 1);
  current.splice(targetIndex, 0, moved);
  autoChatDirty = true;
  renderAutoChatSchedules(current);
}
function endScheduleDrag(element) { if (element) element.classList.remove('dragging'); draggedAutoChatIndex = null; }

function addAutoChatSchedule() {
  if (autoChatSaveInFlight) return;
  const current = collectAutoChatSchedules();
  current.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), enabled: true, mode: 'interval', intervalSeconds: 3600, times: [], messages: [''], messageDelaySeconds: 2 });
  autoChatDirty = true;
  renderAutoChatSchedules(current);
  const rows = byId('autoChatSchedules')?.querySelectorAll('.schedule-row') || [];
  rows[rows.length - 1]?.querySelector('[data-field="messages"]')?.focus();
}

function removeAutoChatSchedule(index) {
  if (autoChatSaveInFlight) return;
  const current = collectAutoChatSchedules();
  current.splice(index, 1);
  autoChatDirty = true;
  renderAutoChatSchedules(current);
}

function normalizeBotSchedulerForClient(schedules) {
  const raw = Array.isArray(schedules) ? schedules[0] : null;
  if (!raw) return { id: String(Date.now()), enabled: true, mode: 'fixed', items: [] };

  const mode = raw.mode === 'cycle' ? 'cycle' : 'fixed';
  let items = Array.isArray(raw.items) ? raw.items.slice() : [];

  if (!items.length && Array.isArray(schedules)) {
    items = schedules
      .filter(s => (s.mode === 'cycle' ? 'cycle' : 'fixed') === mode)
      .flatMap(s => mode === 'fixed'
        ? [{ id: s.id, action: s.action, time: s.time }]
        : [
            { id: String(s.id || '') + '-stop', action: 'stop', afterMinutes: clampClientNumber(s.offAfterMinutes, 120, 1, 43200) },
            { id: String(s.id || '') + '-start', action: 'start', afterMinutes: clampClientNumber(s.onAfterMinutes, 300, 1, 43200) }
          ]);
  }

  return {
    id: String(raw.id || Date.now()),
    enabled: raw.enabled !== false,
    mode,
    items: items.map(function(item, index) {
      return mode === 'fixed'
        ? { id: String(item.id || Date.now() + '-' + index), action: item.action === 'start' ? 'start' : 'stop', time: String(item.time || '03:00') }
        : { id: String(item.id || Date.now() + '-' + index), action: item.action === 'start' ? 'start' : 'stop', afterMinutes: clampClientNumber(item.afterMinutes, index === 0 ? 120 : 300, 1, 43200) };
    })
  };
}

function renderBotScheduleModeNote(mode) {
  const note = byId('botScheduleModeNote');
  if (!note) return;
  note.textContent = mode === 'cycle'
    ? 'Mỗi dòng kích hoạt sau khoảng thời gian tính từ dòng ngay phía trên. Dòng đầu tiên tính từ lúc bấm Lưu. Kéo ⋮⋮ để đổi thứ tự.'
    : 'Mỗi dòng dùng giờ Việt Nam (GMT+7). Có thể thêm nhiều giờ: 03:00 Tắt → 06:00 Bật → 12:00 Tắt → 19:00 Bật.';
}

function renderBotSchedules(schedules) {
  const box = byId('botSchedules');
  if (!box) return;
  const scheduler = normalizeBotSchedulerForClient(schedules);
  botSchedules = scheduler.items.length || (Array.isArray(schedules) && schedules.length) ? [scheduler] : [];

  if (byId('botScheduleMode')) byId('botScheduleMode').value = scheduler.mode;
  if (byId('botScheduleEnabled')) byId('botScheduleEnabled').checked = scheduler.enabled !== false;
  renderBotScheduleModeNote(scheduler.mode);

  if (!scheduler.items.length) {
    box.innerHTML = '<div class="note">Chưa có dòng hẹn giờ. Bấm “＋ Thêm” để tạo dòng đầu tiên.</div>';
    return;
  }

  box.innerHTML = scheduler.items.map(function(item, index) {
    const actionValue = item.action === 'start' ? 'start' : 'stop';
    const actionText = actionValue === 'start' ? 'Bật Bot' : 'Tắt Bot';
    const timing = scheduler.mode === 'fixed'
      ? '<input data-field="time" class="time-input" type="time" value="' + escapeHtml(item.time || '03:00') + '">'
      : '<input data-field="afterMinutes" class="minutes-input" type="number" min="1" max="43200" value="' + clampClientNumber(item.afterMinutes, index === 0 ? 120 : 300, 1, 43200) + '" title="Phút">';
    const relation = scheduler.mode === 'fixed'
      ? 'Mỗi ngày'
      : (index === 0 ? 'Tính từ lúc lưu' : 'Tính từ dòng ' + index);

    return '' +
      '<div class="schedule-row" draggable="true" data-index="' + index + '" data-id="' + escapeHtml(item.id) + '" ondragstart="dragBotSchedule(event,' + index + ')" ondragover="allowBotScheduleDrop(event)" ondrop="dropBotSchedule(event,' + index + ')" ondragend="endBotScheduleDrag(this)">' +
        '<div class="schedule-row-top">' +
          '<div class="schedule-handle" title="Kéo để đổi thứ tự">⋮⋮</div>' +
          '<div class="schedule-row-title">' + (index + 1) + '. ' + actionText + '</div>' +
          '<div class="schedule-inline">' +
            '<select data-field="action" class="action-select">' +
              '<option value="stop"' + (actionValue === 'stop' ? ' selected' : '') + '>Tắt</option>' +
              '<option value="start"' + (actionValue === 'start' ? ' selected' : '') + '>Bật</option>' +
            '</select>' + timing +
          '</div>' +
          '<button class="small danger" type="button" onclick="removeBotSchedule(' + index + ')">Xóa</button>' +
        '</div>' +
        '<div class="schedule-meta" style="margin-top:5px;"><span>' + relation + '</span>' +
          (scheduler.mode === 'cycle' ? '<span>•</span><span>Thời gian tính từ dòng kề trên</span>' : '') +
        '</div>' +
      '</div>';
  }).join('');
}

function collectBotSchedules() {
  const box = byId('botSchedules');
  const modeSelect = byId('botScheduleMode');
  if (!box || !modeSelect) return [];
  const mode = modeSelect.value === 'cycle' ? 'cycle' : 'fixed';
  const scheduler = normalizeBotSchedulerForClient(botSchedules);
  const items = Array.from(box.querySelectorAll('.schedule-row')).map(function(row, index) {
    const get = field => row.querySelector('[data-field="' + field + '"]');
    const id = row.dataset.id || scheduler.items[index]?.id || (Date.now() + '-' + index);
    if (mode === 'fixed') {
      return { id, action: get('action')?.value === 'start' ? 'start' : 'stop', time: String(get('time')?.value || '').trim() };
    }
    return { id, action: get('action')?.value === 'start' ? 'start' : 'stop', afterMinutes: clampClientNumber(get('afterMinutes')?.value, index === 0 ? 120 : 300, 1, 43200) };
  });
  if (!items.length) return [];
  return [{ id: scheduler.id || String(Date.now()), enabled: byId('botScheduleEnabled') ? !!byId('botScheduleEnabled').checked : true, mode, items }];
}

function validateBotSchedules(schedules) {
  if (!schedules.length) return '';
  if (schedules.length !== 1) return 'Chỉ được lưu một chế độ hẹn giờ Bot cùng lúc.';
  const schedule = schedules[0];
  if (!Array.isArray(schedule.items) || !schedule.items.length) return 'Hẹn giờ Bot chưa có dòng nào.';
  if (schedule.mode === 'fixed') {
    const seen = new Set();
    for (let i = 0; i < schedule.items.length; i++) {
      const time = schedule.items[i].time;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return 'Dòng #' + (i + 1) + ' có giờ không hợp lệ.';
      if (seen.has(time)) return 'Dòng #' + (i + 1) + ' bị trùng giờ ' + time + '.';
      seen.add(time);
    }
  } else {
    for (let i = 0; i < schedule.items.length; i++) {
      const value = Number(schedule.items[i].afterMinutes);
      if (!Number.isFinite(value) || value < 1 || value > 43200) return 'Dòng #' + (i + 1) + ' có thời gian chờ không hợp lệ.';
    }
  }
  return '';
}

function botScheduleModeChanged(select) {
  const current = collectBotSchedules();
  const scheduler = normalizeBotSchedulerForClient(current.length ? current : botSchedules);
  const newMode = select && select.value === 'cycle' ? 'cycle' : 'fixed';
  const items = scheduler.items.map(function(item, index) {
    return newMode === 'fixed'
      ? { id: item.id, action: item.action, time: defaultFixedTime(index) }
      : { id: item.id, action: item.action, afterMinutes: index === 0 ? 120 : 300 };
  });
  botSchedules = [{ id: scheduler.id || String(Date.now()), enabled: byId('botScheduleEnabled') ? !!byId('botScheduleEnabled').checked : true, mode: newMode, items }];
  botScheduleDirty = true;
  renderBotSchedules(botSchedules);
}

function addBotSchedule() {
  const current = collectBotSchedules();
  const scheduler = normalizeBotSchedulerForClient(current.length ? current : botSchedules);
  const index = scheduler.items.length;
  const item = scheduler.mode === 'fixed'
    ? { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), action: 'stop', time: defaultFixedTime(index) }
    : { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), action: index % 2 === 0 ? 'stop' : 'start', afterMinutes: index === 0 ? 120 : 300 };
  scheduler.items.push(item);
  botSchedules = [scheduler];
  botScheduleDirty = true;
  renderBotSchedules(botSchedules);
}

function removeBotSchedule(index) {
  if (botScheduleSaveInFlight) return;
  const scheduler = normalizeBotSchedulerForClient(collectBotSchedules());
  scheduler.items.splice(index, 1);
  botSchedules = scheduler.items.length ? [scheduler] : [];
  botScheduleDirty = true;
  renderBotSchedules(botSchedules);
}

let draggedBotScheduleIndex = null;
function dragBotSchedule(event, index) {
  draggedBotScheduleIndex = index;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(index));
  event.currentTarget.classList.add('dragging');
}
function allowBotScheduleDrop(event) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
function dropBotSchedule(event, targetIndex) {
  event.preventDefault();
  const from = draggedBotScheduleIndex;
  draggedBotScheduleIndex = null;
  if (!Number.isInteger(from) || from === targetIndex) return;
  const scheduler = normalizeBotSchedulerForClient(collectBotSchedules());
  const [moved] = scheduler.items.splice(from, 1);
  scheduler.items.splice(targetIndex, 0, moved);
  botSchedules = [scheduler];
  botScheduleDirty = true;
  renderBotSchedules(botSchedules);
}
function endBotScheduleDrag(element) { if (element) element.classList.remove('dragging'); draggedBotScheduleIndex = null; }

async function saveSettings() {
  if (settingsSaveInFlight) return;

  invalidatePendingReads();

  const payload = {
    settings: {
      ecoMode: !!(byId('settingEcoMode') && byId('settingEcoMode').checked),
      autoTotem: !!(byId('settingAutoTotem') && byId('settingAutoTotem').checked),
      antiHungry: !!(byId('settingAntiHungry') && byId('settingAntiHungry').checked),
      autoReconnect: !!(byId('settingAutoReconnect') && byId('settingAutoReconnect').checked),
      antiAfkKick: !!(byId('settingAntiAfkKick') && byId('settingAntiAfkKick').checked)
    }
  };

  settingsSaveInFlight = true;
  setSettingsButtonsDisabled(true);

  try {
    const result = await apiJson('/api/settings', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });

    if (!result.ok) {
      showToast(result.data.error || 'Lưu setting thất bại.');
      return;
    }

    settingsDirty = false;
    renderPublicSettings(result.data);
    showToast(result.data.message || 'Đã lưu setting.');
  } catch (err) {
    showToast(err.message || 'Không thể kết nối server web.');
  } finally {
    settingsSaveInFlight = false;
    setSettingsButtonsDisabled(false);
    runQueuedRefresh();
  }
}

async function saveAutoChat() {
  if (autoChatSaveInFlight) return;

  invalidatePendingReads();

  const schedules = collectAutoChatSchedules();
  const validationError = validateAutoChatSchedules(schedules);

  if (validationError) {
    showToast(validationError);
    return;
  }

  autoChatSaveInFlight = true;
  setAutoChatButtonsDisabled(true);

  try {
    const result = await apiJson('/api/auto-chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ autoChatSchedules: schedules })
    });

    if (!result.ok) {
      showToast(result.data.error || 'Lưu Auto Chat thất bại.');
      return;
    }

    autoChatDirty = false;
    const serverSchedules = Array.isArray(result.data.autoChatSchedules)
      ? result.data.autoChatSchedules
      : schedules;

    renderAutoChatSchedules(serverSchedules);
    showToast(result.data.message || 'Đã lưu Auto Chat.');
  } catch (err) {
    showToast(err.message || 'Không thể kết nối server web.');
  } finally {
    autoChatSaveInFlight = false;
    setAutoChatButtonsDisabled(false);
    runQueuedRefresh();
  }
}

async function saveBotSchedules() {
  if (botScheduleSaveInFlight) return;

  invalidatePendingReads();

  const schedules = collectBotSchedules();
  const validationError = validateBotSchedules(schedules);

  if (validationError) {
    showToast(validationError);
    return;
  }

  botScheduleSaveInFlight = true;
  setBotScheduleButtonsDisabled(true);

  try {
    const result = await apiJson('/api/bot-schedules', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ botSchedules: schedules })
    });

    if (!result.ok) {
      showToast(result.data.error || 'Lưu hẹn giờ Bot thất bại.');
      return;
    }

    botScheduleDirty = false;
    const serverSchedules = Array.isArray(result.data.botSchedules)
      ? result.data.botSchedules
      : schedules;

    renderBotSchedules(serverSchedules);
    showToast(result.data.message || 'Đã lưu hẹn giờ Bot.');
  } catch (err) {
    showToast(err.message || 'Không thể kết nối server web.');
  } finally {
    botScheduleSaveInFlight = false;
    setBotScheduleButtonsDisabled(false);
    runQueuedRefresh();
  }
}

function setSettingsButtonsDisabled(disabled) {
  document.querySelectorAll('#settingsPanel button, #settingsPanel input, #settingsPanel select, #settingsPanel textarea').forEach(function(element) {
    element.disabled = !!disabled;
  });
}

function setAutoChatButtonsDisabled(disabled) {
  document.querySelectorAll('#autoChatPanel button, #autoChatPanel input, #autoChatPanel select, #autoChatPanel textarea').forEach(function(element) {
    element.disabled = !!disabled;
  });
}

function setBotScheduleButtonsDisabled(disabled) {
  document.querySelectorAll('#botSchedulePanel button, #botSchedulePanel input, #botSchedulePanel select, #botSchedulePanel textarea').forEach(function(element) {
    element.disabled = !!disabled;
  });
}


async function startBot() {
  return runBotAction('start');
}

async function stopBot() {
  return runBotAction('stop');
}

async function restartBot() {
  return runBotAction('restart');
}

async function runBotAction(action) {
  if (actionRequestInFlight) return;

  if (action === 'stop' || action === 'restart') {
    manualStopRequested = true;
  }

  invalidatePendingReads();
  actionRequestInFlight = true;

  const buttons = [
    byId('startButton'),
    byId('stopButton'),
    byId('restartButton')
  ];

  buttons.forEach(function(button) {
    if (button) button.disabled = true;
  });

  showToast(
    action === 'start'
      ? 'Đang chạy bot...'
      : action === 'stop'
        ? 'Đang dừng bot...'
        : 'Đang khởi động lại bot...'
  );

  try {
    const result = await apiJson('/api/bot/' + action, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}'
    });

    showToast(
      result.data.message ||
      result.data.error ||
      (result.ok ? 'Đã xử lý.' : 'Thao tác thất bại.')
    );

    await refresh(true);
  } catch (err) {
    showToast(err.message || 'Không thể kết nối server web.');
  } finally {
    actionRequestInFlight = false;
    buttons.forEach(function(button) {
      if (button) button.disabled = false;
    });
  }
}

let commandHistory = [];
let commandHistoryIndex = -1;

function copyToClipboard(text, label) {
  if (!text || text === '-') return;
  const clean = String(text).trim();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(clean).then(function() {
      showToast('Đã copy ' + (label || '') + ': ' + clean);
    }).catch(function() {
      fallbackCopy(clean, label);
    });
  } else {
    fallbackCopy(clean, label);
  }
}

function fallbackCopy(text, label) {
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast('Đã copy ' + (label || '') + ': ' + text);
  } catch (_) {
    showToast('Không thể copy tự động.');
  }
}

function quickSendCommand(cmd) {
  const input = byId('messageInput');
  if (!input) return;
  const raw = String(cmd || '').trim();
  const needsSpace = ['/dn', '/login', '/pay'].includes(raw.toLowerCase());
  const finalCmd = needsSpace ? (raw + ' ') : raw;
  input.value = finalCmd;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function sendMessage(event) {
  if (event && event.preventDefault) event.preventDefault();

  const input = byId('messageInput');
  const text = input ? input.value : '';

  if (!text.trim()) return;

  commandHistory.unshift(text.trim());
  if (commandHistory.length > 50) commandHistory.pop();
  commandHistoryIndex = -1;

  const result = await apiJson('/api/bot/send', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({text: text})
  });

  if (result.ok && input) input.value = '';

  showToast(
    result.data.message ||
    result.data.error ||
    (result.ok ? 'Đã gửi.' : 'Gửi thất bại.')
  );

  if (result.ok) {
    await loadChatLogs(true);
  }
}

function exportLogsToFile() {
  const logEl = document.getElementById('logs');
  const text = (logEl ? logEl.innerText : '') || 'Chưa có log.';
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'kingmc-bot-log-' + new Date().toISOString().slice(0, 10) + '.txt';
  a.click();
  showToast('✅ Đã tải file log về máy.');
}

async function clearEventHistory() {
  if (!confirm('Xóa toàn bộ Event Log?')) return;

  const result = await apiJson('/api/bot/logs/clear', {
    method: 'POST'
  });

  if (result.ok) {
    lastLogRevision = -1;
    await loadLogs(true);
  }

  showToast(
    result.data.message ||
    result.data.error ||
    'Đã xử lý.'
  );
}

function renderBotProxy(proxy) {
  const badge = byId('botProxyBadge');
  const enabledInput = byId('proxyEnabledInput');
  const protocolInput = byId('proxyProtocolInput');
  const hostInput = byId('proxyHostInput');
  const portInput = byId('proxyPortInput');
  const usernameInput = byId('proxyUsernameInput');
  const passwordInput = byId('proxyPasswordInput');

  const p = proxy || {};
  if (badge) {
    if (p.enabled) {
      badge.textContent = '🟢 BẬT';
      badge.style.background = 'rgba(34, 197, 94, 0.2)';
      badge.style.color = '#4ade80';
    } else {
      badge.textContent = 'TẮT';
      badge.style.background = 'var(--border)';
      badge.style.color = 'var(--muted)';
    }
  }

  // Chỉ điền giá trị khi người dùng không đang nhập dở
  if (enabledInput && document.activeElement !== enabledInput) enabledInput.checked = !!p.enabled;
  if (protocolInput && document.activeElement !== protocolInput) protocolInput.value = p.protocol || 'socks5';
  if (hostInput && document.activeElement !== hostInput) hostInput.value = p.host || '';
  if (portInput && document.activeElement !== portInput) portInput.value = p.port || '';
  if (usernameInput && document.activeElement !== usernameInput) usernameInput.value = p.username || '';
  if (passwordInput && document.activeElement !== passwordInput) passwordInput.value = p.password || '';
}

async function saveBotProxy() {
  const enabled = !!byId('proxyEnabledInput')?.checked;
  const protocol = byId('proxyProtocolInput')?.value || 'socks5';
  const host = byId('proxyHostInput')?.value?.trim() || '';
  const port = Number(byId('proxyPortInput')?.value) || 0;
  const username = byId('proxyUsernameInput')?.value?.trim() || '';
  const password = byId('proxyPasswordInput')?.value || '';

  if (enabled && (!host || !port)) {
    showToast('Vui lòng nhập đầy đủ Host và Port khi kích hoạt Proxy!');
    return;
  }

  const res = await apiJson('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proxy: { enabled, protocol, host, port, username, password }
    })
  });

  if (res.ok) {
    showToast('Đã lưu cấu hình Proxy thành công!');
    await refresh(true);
  } else {
    showToast('Lỗi lưu Proxy: ' + (res.data?.error || 'Lỗi không xác định'));
  }
}

async function testBotProxy() {
  const btn = byId('botProxyTestBtn');
  const resDiv = byId('botProxyTestResult');
  const enabled = !!byId('proxyEnabledInput')?.checked;
  const protocol = byId('proxyProtocolInput')?.value || 'socks5';
  const host = byId('proxyHostInput')?.value?.trim() || '';
  const port = Number(byId('proxyPortInput')?.value) || 0;
  const username = byId('proxyUsernameInput')?.value?.trim() || '';
  const password = byId('proxyPasswordInput')?.value || '';

  if (!host || !port) {
    showToast('Vui lòng nhập Host và Port Proxy trước khi kiểm tra!');
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Đang test...'; }
  if (resDiv) { resDiv.innerHTML = '<span style="color:var(--accent);">Đang kết nối thử tới Proxy...</span>'; }

  try {
    const res = await apiJson('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy: { enabled, protocol, host, port, username, password }
      })
    });

    if (res.ok && res.data?.ok) {
      if (resDiv) resDiv.innerHTML = '<span style="color:var(--green);font-weight:700;">✅ ' + escapeHtml(res.data.message) + '</span>';
      showToast('Proxy hoạt động tốt! Ping: ' + res.data.latencyMs + 'ms');
    } else {
      const err = res.data?.error || 'Không thể kết nối tới Proxy.';
      if (resDiv) resDiv.innerHTML = '<span style="color:var(--red);font-weight:700;">❌ ' + escapeHtml(err) + '</span>';
      showToast('Kiểm tra Proxy thất bại: ' + err);
    }
  } catch (e) {
    if (resDiv) resDiv.innerHTML = '<span style="color:var(--red);">❌ Lỗi kiểm tra: ' + escapeHtml(e.message) + '</span>';
    showToast('Lỗi kiểm tra: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🧪 Kiểm Tra Kết Nối'; }
  }
}

async function clearBotProxy() {
  if (byId('proxyEnabledInput')) byId('proxyEnabledInput').checked = false;
  if (byId('proxyHostInput')) byId('proxyHostInput').value = '';
  if (byId('proxyPortInput')) byId('proxyPortInput').value = '';
  if (byId('proxyUsernameInput')) byId('proxyUsernameInput').value = '';
  if (byId('proxyPasswordInput')) byId('proxyPasswordInput').value = '';
  await saveBotProxy();
}

async function clearChatHistory() {
  if (!confirm('Xóa toàn bộ Chat Log?')) return;

  const result = await apiJson('/api/bot/chat-logs/clear', {
    method: 'POST'
  });

  if (result.ok) {
    lastChatRevision = -1;
    await loadChatLogs(true);
  }

  showToast(
    result.data.message ||
    result.data.error ||
    'Đã xử lý.'
  );
}

async function saveAccount() {
  invalidatePendingReads();

  const usernameInput = byId('usernameInput');
  const passwordInput = byId('passwordInput');

  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!username && !password) {
    showToast('Nhập username hoặc password cần thay đổi.');
    return;
  }

  const result = await apiJson('/api/bot/account', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      username: username,
      password: password
    })
  });

  if (result.ok) {
    if (usernameInput) usernameInput.value = '';
    if (passwordInput) passwordInput.value = '';
    await refresh(true);
  }

  showToast(
    result.data.message ||
    result.data.error ||
    'Đã xử lý.'
  );
}

function itemLabel(item) {
  if (!item) return '-';
  const name = item.displayName || item.name || '-';
  const count = Number(item.count || 0);
  return String(name).replace(/_/g, ' ') +
    (count > 1 ? ' x' + count : '');
}

function createInventorySlot(item, slot, selected) {
  const el = document.createElement('div');

  el.className =
    'inventory-slot' +
    (item ? '' : ' empty') +
    (selected ? ' selected' : '');

  el.draggable = !!item;
  el.dataset.slot = String(slot);

  el.ondragstart = function(event) {
    draggedSlot = slot;

    try {
      event.dataTransfer.setData('text/plain', String(slot));
      event.dataTransfer.effectAllowed = 'move';
    } catch (_) {}
  };

  el.ondragover = allowDrop;
  el.ondragleave = clearDragOver;
  el.ondrop = function(event) {
    dropInventorySlot(event, slot);
  };

  if (slot >= 36 && slot <= 44) {
    el.onclick = function() {
      selectHotbar(slot - 36);
    };
  }

  const index = document.createElement('div');
  index.className = 'slot-index';
  index.textContent = slot >= 36
    ? String(slot - 35)
    : String(slot - 8);

  const name = document.createElement('div');
  name.className = 'slot-name';
  name.textContent = itemLabel(item);

  const count = document.createElement('div');
  count.className = 'slot-count';
  count.textContent = item && Number(item.count || 0) > 1
    ? String(item.count)
    : '';

  el.appendChild(index);
  el.appendChild(name);
  el.appendChild(count);

  return el;
}

function renderInventory() {
  if (!inventory) return;
  const invSlots = inventory.slots || [];
  let usedCount = 0;
  for (let i = 9; i <= 44; i++) {
    if (invSlots[i]) usedCount++;
  }
  const capPercent = Math.round((usedCount / 36) * 100);
  const capEl = document.getElementById('inventoryCapacity');
  if (capEl) {
    capEl.textContent = usedCount + '/36 ô (' + capPercent + '%)';
    capEl.className = 'capacity-badge' + (capPercent >= 90 ? ' danger' : capPercent >= 75 ? ' warning' : '');
  }

  const health = Math.max(
    0,
    Math.min(20, Number(inventory.health || 0))
  );

  const food = Math.max(
    0,
    Math.min(20, Number(inventory.food || 0))
  );

  const healthElement = byId('inventoryHealth');
  const foodElement = byId('inventoryFood');

  if (healthElement) {
    const hearts = Math.round(health / 2);
    const heartsStr = '❤️'.repeat(hearts) + '🖤'.repeat(Math.max(0, 10 - hearts));
    healthElement.innerHTML = health.toFixed(1) + ' / 20 <span style="font-size:11px;margin-left:4px;" title="' + health + '/20 HP">' + heartsStr + '</span>';
  }

  if (foodElement) {
    const foods = Math.round(food / 2);
    const foodStr = '🍖'.repeat(foods) + '🦴'.repeat(Math.max(0, 10 - foods));
    foodElement.innerHTML = food.toFixed(1) + ' / 20 <span style="font-size:11px;margin-left:4px;" title="' + food + '/20 Đói">' + foodStr + '</span>';
  }

  const healthBar = byId('inventoryHealthBar');
  const foodBar = byId('inventoryFoodBar');

  if (healthBar) healthBar.style.width =
    (health / 20 * 100) + '%';

  if (foodBar) foodBar.style.width =
    (food / 20 * 100) + '%';

  const golden = byId('inventoryGoldenApple');
  const totem = byId('inventoryTotem');
  const offhand = byId('inventoryOffhand');
  const foodCount = byId('inventoryFoodCount');

  if (golden) golden.textContent =
    String(inventory.goldenAppleCount || 0);

  if (totem) {
    const tCount = Number(inventory.totemCount || 0);
    totem.innerHTML = tCount <= 1
      ? '<span style="color:var(--red);font-weight:bold;">' + tCount + ' 🚨</span>'
      : '<span style="color:var(--gold);font-weight:bold;">' + tCount + ' 🛡️</span>';
  }

  if (offhand) offhand.textContent =
    String(inventory.offhand || '-').replace(/_/g, ' ');

  if (foodCount) foodCount.textContent =
    String(inventory.foodCount || 0);

  const armor = inventory.armor || {};

  if (byId('equipHead')) byId('equipHead').textContent = itemLabel(armor.head);
  if (byId('equipTorso')) byId('equipTorso').textContent = itemLabel(armor.torso);
  if (byId('equipLegs')) byId('equipLegs').textContent = itemLabel(armor.legs);
  if (byId('equipFeet')) byId('equipFeet').textContent = itemLabel(armor.feet);

  const off = inventory.slots
    ? inventory.slots['45']
    : null;

  if (byId('equipOffhand')) {
    byId('equipOffhand').textContent = itemLabel(off);
  }

  const revision = byId('inventoryRevision');
  if (revision) revision.textContent =
    'revision ' + String(inventory.revision || 0);

  const slots = inventory.slots || {};
  const main = byId('mainInventory');
  const hotbar = byId('inventoryHotbar');

  if (main) {
    main.innerHTML = '';
    for (let slot = 9; slot <= 35; slot++) {
      main.appendChild(
        createInventorySlot(
          slots[String(slot)] || null,
          slot,
          false
        )
      );
    }
  }

  if (hotbar) {
    hotbar.innerHTML = '';

    const selected = Number(
      inventory.selectedHotbar ??
      inventory.selectedSlot ??
      0
    );

    for (let slot = 36; slot <= 44; slot++) {
      hotbar.appendChild(
        createInventorySlot(
          slots[String(slot)] || null,
          slot,
          slot - 36 === selected
        )
      );
    }
  }
}

function allowDrop(event) {
  event.preventDefault();

  try {
    event.dataTransfer.dropEffect = 'move';
  } catch (_) {}

  if (event.currentTarget && event.currentTarget.classList) {
    event.currentTarget.classList.add('dragover');
  }
}

function clearDragOver(event) {
  if (event.currentTarget && event.currentTarget.classList) {
    event.currentTarget.classList.remove('dragover');
  }
}

function startEquipmentDrag(event, destination) {
  const slotMap = {
    head: 5,
    torso: 6,
    legs: 7,
    feet: 8,
    'off-hand': 45
  };

  draggedSlot = slotMap[destination];

  try {
    event.dataTransfer.setData(
      'text/plain',
      String(draggedSlot)
    );
    event.dataTransfer.effectAllowed = 'move';
  } catch (_) {}
}

function getDragSource(event) {
  let source = draggedSlot;

  try {
    const value = event.dataTransfer.getData('text/plain');

    if (value !== '') {
      const parsed = Number(value);

      if (Number.isInteger(parsed)) {
        source = parsed;
      }
    }
  } catch (_) {}

  draggedSlot = null;
  return Number.isInteger(source) ? source : null;
}

async function dropInventorySlot(event, destinationSlot) {
  event.preventDefault();
  clearDragOver(event);

  const sourceSlot = getDragSource(event);

  if (
    !Number.isInteger(sourceSlot) ||
    sourceSlot === destinationSlot
  ) {
    return;
  }

  if (sourceSlot >= 5 && sourceSlot <= 8) {
    const map = {
      5: 'head',
      6: 'torso',
      7: 'legs',
      8: 'feet'
    };

    await unequipAndMove(map[sourceSlot], destinationSlot);
    return;
  }

  if (sourceSlot === 45) {
    await unequipAndMove('off-hand', destinationSlot);
    return;
  }

  await moveInventoryItem(
    sourceSlot,
    destinationSlot
  );
}

async function unequipAndMove(destination, destinationSlot) {
  const result = await postInventory(
    '/inventory/unequip',
    {
      destination: destination,
      revision: inventory
        ? inventory.revision
        : 0
    }
  );

  if (!result.ok) {
    showToast(result.data.error || 'Không thể tháo trang bị.');
    return;
  }

  if (result.data.inventory) {
    inventory = result.data.inventory;
    renderInventory();
  }

  const sourceSlot = (result.data && result.data.unequippedToSlot !== undefined)
    ? result.data.unequippedToSlot
    : null;

  if (
    sourceSlot !== null &&
    sourceSlot !== destinationSlot
  ) {
    await moveInventoryItem(
      sourceSlot,
      destinationSlot
    );
  }
}

async function moveInventoryItem(sourceSlot, destSlot) {
  if (inventoryActionInFlight || !inventory) return;

  inventoryActionInFlight = true;

  try {
    const result = await postInventory(
      '/inventory/move',
      {
        sourceSlot: sourceSlot,
        destSlot: destSlot,
        revision: inventory.revision
      }
    );

    if (result.data.inventory) {
      inventory = result.data.inventory;
      renderInventory();
    }

    showToast(
      result.data.message ||
      result.data.error ||
      (result.ok ? 'Đã di chuyển item.' : 'Di chuyển thất bại.')
    );

    if (!result.ok && result.status === 409) {
      await refresh(true);
    }
  } finally {
    inventoryActionInFlight = false;
  }
}

function dropItemToWorld(event) {
  event.preventDefault();
  clearDragOver(event);

  const sourceSlot = getDragSource(event);

  if (!Number.isInteger(sourceSlot)) return;

  if (sourceSlot >= 5 && sourceSlot <= 8) {
    unequipEquipment(
      ['head', 'torso', 'legs', 'feet'][sourceSlot - 5]
    );
    return;
  }

  if (sourceSlot === 45) {
    unequipEquipment('off-hand');
    return;
  }

  dropInventoryItem(sourceSlot);
}

async function dropInventoryItem(sourceSlot) {
  if (inventoryActionInFlight || !inventory) return;

  inventoryActionInFlight = true;

  try {
    const result = await postInventory(
      '/inventory/drop',
      {
        sourceSlot: sourceSlot,
        revision: inventory.revision
      }
    );

    if (result.data.inventory) {
      inventory = result.data.inventory;
      renderInventory();
    }

    showToast(
      result.data.message ||
      result.data.error ||
      (result.ok ? 'Đã vứt item.' : 'Vứt item thất bại.')
    );

    if (!result.ok && result.status === 409) {
      await refresh(true);
    }
  } finally {
    inventoryActionInFlight = false;
  }
}

async function dropEquip(event, destination) {
  event.preventDefault();
  clearDragOver(event);

  const sourceSlot = getDragSource(event);

  if (!Number.isInteger(sourceSlot)) return;

  if (
    (sourceSlot >= 5 && sourceSlot <= 8) ||
    sourceSlot === 45
  ) {
    showToast('Không thể lấy item từ equipment để equip vào chính equipment.');
    return;
  }

  await equipDetailItem(sourceSlot, destination);
}

async function equipDetailItem(sourceSlot, destination) {
  if (inventoryActionInFlight || !inventory) return;

  inventoryActionInFlight = true;

  try {
    const result = await postInventory(
      '/inventory/equip',
      {
        sourceSlot: sourceSlot,
        destination: destination,
        revision: inventory.revision
      }
    );

    if (result.data.inventory) {
      inventory = result.data.inventory;
      renderInventory();
    }

    showToast(
      result.data.message ||
      result.data.error ||
      (result.ok ? 'Đã trang bị item.' : 'Trang bị thất bại.')
    );

    if (!result.ok && result.status === 409) {
      await refresh(true);
    }
  } finally {
    inventoryActionInFlight = false;
  }
}

async function unequipEquipment(destination) {
  if (inventoryActionInFlight || !inventory) return;

  inventoryActionInFlight = true;

  try {
    const result = await postInventory(
      '/inventory/unequip',
      {
        destination: destination,
        revision: inventory.revision
      }
    );

    if (result.data.inventory) {
      inventory = result.data.inventory;
      renderInventory();
    }

    showToast(
      result.data.message ||
      result.data.error ||
      (result.ok ? 'Đã tháo trang bị.' : 'Tháo trang bị thất bại.')
    );

    if (!result.ok && result.status === 409) {
      await refresh(true);
    }
  } finally {
    inventoryActionInFlight = false;
  }
}

async function selectHotbar(slot) {
  if (inventoryActionInFlight || !inventory) return;

  inventoryActionInFlight = true;

  try {
    const result = await postInventory(
      '/inventory/select',
      {
        slot: slot,
        revision: inventory.revision
      }
    );

    if (result.data.inventory) {
      inventory = result.data.inventory;
      renderInventory();
    }

    showToast(
      result.data.message ||
      result.data.error ||
      (result.ok ? 'Đã chọn hotbar.' : 'Không thể chọn hotbar.')
    );

    if (!result.ok && result.status === 409) {
      await refresh(true);
    }
  } finally {
    inventoryActionInFlight = false;
  }
}

async function postInventory(path, body) {
  const fullPath = path.startsWith('/api') ? path : ('/api' + (path.startsWith('/') ? path : '/' + path));
  return apiJson(fullPath, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
}

function nearBottom(box) {
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}

async function loadLogs(force, expectedGeneration = refreshGeneration) {
  const box = byId('logs');
  if (!box) return;

  if (!force && bot && lastLogRevision === Number(bot.logRevision)) {
    return;
  }

  try {
    const result = await apiJson('/api/bot/logs');

    if (!isPollingActive || byId('mainApp')?.classList.contains('hidden')) return;
    if (expectedGeneration !== null && expectedGeneration !== refreshGeneration) return;
    if (!result.ok) return;

    const logs = Array.isArray(result.data.logs)
      ? result.data.logs
      : [];

    const keep = nearBottom(box);

    box.innerHTML = logs.map(function(line) {
      return '<div class="line">' +
        escapeHtml(line) +
        '</div>';
    }).join('');

    lastLogRevision = Number(result.data.revision || 0);

    const revision = byId('eventRevision');
    if (revision) revision.textContent =
      'revision ' + lastLogRevision;

    if (keep) box.scrollTop = box.scrollHeight;
  } catch (err) {
    console.error('[BOT UI] loadLogs', err);
  }
}

async function loadChatLogs(force, expectedGeneration = refreshGeneration) {
  const box = byId('chatLogs');
  if (!box) return;

  if (!force && bot &&
      lastChatRevision === Number(bot.chatLogRevision)) {
    return;
  }

  try {
    const result = await apiJson('/api/bot/chat-logs');

    if (!isPollingActive || byId('mainApp')?.classList.contains('hidden')) return;
    if (expectedGeneration !== null && expectedGeneration !== refreshGeneration) return;
    if (!result.ok) return;

    const logs = Array.isArray(result.data.logs)
      ? result.data.logs
      : [];

    const keep = nearBottom(box);

    box.innerHTML = logs.map(function(line) {
      return '<div class="line">' +
        escapeHtml(line) +
        '</div>';
    }).join('');

    lastChatRevision = Number(result.data.revision || 0);

    const revision = byId('chatRevision');
    if (revision) revision.textContent =
      'revision ' + lastChatRevision;

    if (keep) box.scrollTop = box.scrollHeight;
  } catch (err) {
    console.error('[BOT UI] loadChatLogs', err);
  }
}

let lastSnapshotRev = '';
let isPollingActive = false;

async function refresh(force) {
  if (!isPollingActive || byId('mainApp')?.classList.contains('hidden')) {
    refreshQueued = false;
    refreshInFlight = false;
    return;
  }

  if (refreshInFlight) {
    if (force) refreshQueued = true;
    return;
  }

  refreshInFlight = true;
  const generation = ++refreshGeneration;

  try {
    const url = (force || !lastSnapshotRev)
      ? '/api/snapshot'
      : '/api/snapshot?rev=' + encodeURIComponent(lastSnapshotRev);
    const result = await apiJson(url);

    if (
      generation !== refreshGeneration
    ) {
      return;
    }

    if (result.status === 401 || result.status === 403) {
      isPollingActive = false;
      refreshQueued = false;
      if (refreshTimerId) {
        clearTimeout(refreshTimerId);
        refreshTimerId = null;
      }
      byId('mainApp')?.classList.add('hidden');
      byId('botLogoutBtn')?.classList.add('hidden');
      const overlay = byId('loginGateOverlay');
      if (overlay) overlay.style.display = 'flex';
      return;
    }

    if (!result.ok) {
      showToast(
        result.data.error ||
        'Không thể lấy trạng thái bot.'
      );
      return;
    }

    if (result.data && result.data.unchanged) {
      return;
    }

    if (result.data && result.data.rev) {
      lastSnapshotRev = result.data.rev;
    }

    if (result.data.bot) {
      bot = result.data.bot;
      uptimeSyncAt = Date.now();
      renderBotState();
      renderRemoteGui(bot.currentWindow);
    }

    if (result.data.inventory) {
      inventory = result.data.inventory;
      renderInventory();
    }

    if (!settingsDirty && result.data.settings) {
      renderPublicSettings(result.data.settings);
    }

    if (!autoChatDirty && Array.isArray(result.data.autoChatSchedules)) {
      renderAutoChatSchedules(result.data.autoChatSchedules);
    }

    if (!botScheduleDirty && Array.isArray(result.data.botSchedules)) {
      renderBotSchedules(result.data.botSchedules);
    }

    await Promise.all([
      loadLogs(false, generation),
      loadChatLogs(false, generation)
    ]);
  } catch (err) {
    console.error('[BOT UI] refresh', err);
    showToast('Không thể kết nối tới server web.');
  } finally {
    refreshInFlight = false;

    if (
      isPollingActive &&
      !byId('mainApp')?.classList.contains('hidden') &&
      refreshQueued &&
      !actionRequestInFlight &&
      !inventoryActionInFlight &&
      !settingsSaveInFlight &&
      !autoChatSaveInFlight &&
      !botScheduleSaveInFlight
    ) {
      refreshQueued = false;
      void refresh(true);
    } else {
      refreshQueued = false;
    }
  }
}

function markSettingsInputDirty(event) {
  const target = event.target;
  if (!target) return;

  if (
    target.id === 'settingAutoTotem' ||
    target.id === 'settingAntiHungry' ||
    target.id === 'settingAutoReconnect' ||
    target.id === 'settingAntiAfkKick' ||
    target.id === 'settingEcoMode'
  ) {
    markSettingsDirty();
    return;
  }

  if (target.closest && target.closest('#autoChatSchedules')) {
    markAutoChatDirty();
    return;
  }

  if (target.id === 'botScheduleEnabled' || (target.closest && target.closest('#botSchedules'))) {
    markBotScheduleDirty();
  }
}

function updateUptimeDisplay() {
  if (!bot) return;

  const syncedSeconds = Number(bot.uptimeSeconds || 0);
  const elapsed = bot.status === 'afk'
    ? Math.floor((Date.now() - uptimeSyncAt) / 1000)
    : 0;

  const total = Math.min(
    syncedSeconds + elapsed,
    (999 * 60 * 60) - 1
  );

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const element = byId('detailUptime');

  if (element) {
    element.textContent =
      hours + 'h ' +
      minutes + 'm ' +
      seconds + 's';
  }
}

document.addEventListener('input', markSettingsInputDirty);
document.addEventListener('change', markSettingsInputDirty);

window.addAutoChatSchedule = addAutoChatSchedule;
window.dragAutoChatSchedule = dragAutoChatSchedule;
window.allowAutoChatDrop = allowAutoChatDrop;
window.dropAutoChatSchedule = dropAutoChatSchedule;
window.endScheduleDrag = endScheduleDrag;
window.addBotSchedule = addBotSchedule;
window.dragBotSchedule = dragBotSchedule;
window.allowBotScheduleDrop = allowBotScheduleDrop;
window.dropBotSchedule = dropBotSchedule;
window.endBotScheduleDrag = endBotScheduleDrag;
window.allowDrop = allowDrop;
window.clearChatHistory = clearChatHistory;
window.clearDragOver = clearDragOver;
window.clearEventHistory = clearEventHistory;
window.dropEquip = dropEquip;
window.dropItemToWorld = dropItemToWorld;
window.refresh = refresh;
window.removeAutoChatSchedule = removeAutoChatSchedule;
window.removeBotSchedule = removeBotSchedule;
window.restartBot = restartBot;
window.saveAccount = saveAccount;
window.saveAutoChat = saveAutoChat;
window.saveBotSchedules = saveBotSchedules;
window.saveSettings = saveSettings;
window.scheduleModeChanged = scheduleModeChanged;
window.botScheduleModeChanged = botScheduleModeChanged;
window.sendMessage = sendMessage;
window.showToast = showToast;
window.startBot = startBot;
window.startEquipmentDrag = startEquipmentDrag;
window.stopBot = stopBot;
window.unequipEquipment = unequipEquipment;

window.invalidatePendingReads = invalidatePendingReads;
window.renderPublicIp = renderPublicIp;
window.renderSettings = renderSettings;
window.runQueuedRefresh = runQueuedRefresh;
window.addEventListener('error', function(event) {
  try {
    console.error(
      '[BOT UI]',
      event.error || event.message || 'Unknown UI error'
    );
  } catch (_) {}
});

window.addEventListener('unhandledrejection', function(event) {
  try {
    console.error(
      '[BOT UI] Unhandled rejection',
      event.reason
    );
  } catch (_) {}
});

window.startBot = startBot;
window.stopBot = stopBot;
window.restartBot = restartBot;
window.sendMessage = sendMessage;
window.addAutoChatSchedule = addAutoChatSchedule;
window.removeAutoChatSchedule = removeAutoChatSchedule;
window.addBotSchedule = addBotSchedule;
window.removeBotSchedule = removeBotSchedule;
window.botScheduleModeChanged = botScheduleModeChanged;
window.scheduleModeChanged = scheduleModeChanged;
window.saveAutoChat = saveAutoChat;
window.saveBotSchedules = saveBotSchedules;
window.saveSettings = saveSettings;
window.clearEventHistory = clearEventHistory;
window.clearChatHistory = clearChatHistory;
window.saveAccount = saveAccount;
window.allowDrop = allowDrop;
window.clearDragOver = clearDragOver;
window.startEquipmentDrag = startEquipmentDrag;
window.dropEquip = dropEquip;
window.dropItemToWorld = dropItemToWorld;
window.unequipEquipment = unequipEquipment;
window.quickSendCommand = quickSendCommand;
window.copyToClipboard = copyToClipboard;


let soundAlertEnabled = localStorage.getItem('kingmc_sound_alert') === '1';
let lastKnownBotStatus = null;

let _sharedAudioCtx = null;
function getSharedAudioContext() {
  if (!_sharedAudioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) _sharedAudioCtx = new AudioCtx();
  }
  if (_sharedAudioCtx && _sharedAudioCtx.state === 'suspended') {
    _sharedAudioCtx.resume().catch(function() {});
  }
  return _sharedAudioCtx;
}

function playAlertTone(type = 'warn') {
  if (!soundAlertEnabled) return;
  try {
    const ctx = getSharedAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type === 'danger' ? 'sawtooth' : 'sine';
    const now = ctx.currentTime;
    if (type === 'danger') {
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.35);
    } else {
      osc.frequency.setValueAtTime(587.33, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.3);
    }
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
    osc.start(now);
    osc.stop(now + 0.35);
  } catch (_) {}
}

function toggleSoundAlert() {
  soundAlertEnabled = !soundAlertEnabled;
  localStorage.setItem('kingmc_sound_alert', soundAlertEnabled ? '1' : '0');
  updateSoundAlertButton();
  if (soundAlertEnabled) playAlertTone('info');
}

function updateSoundAlertButton() {
  const btn = document.getElementById('soundAlertBtn');
  if (!btn) return;
  if (soundAlertEnabled) {
    btn.className = 'small sound-btn active';
    btn.innerHTML = '🔔 Âm thanh: BẬT';
  } else {
    btn.className = 'small sound-btn';
    btn.innerHTML = '🔕 Âm thanh: TẮT';
  }
}
window.toggleSoundAlert = toggleSoundAlert;

function renderRemoteGui(win) {
  const card = byId('remoteGuiCard');
  if (!card) return;
  if (!win || !win.slots || win.slots.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  const titleEl = byId('remoteGuiTitle');
  if (titleEl) titleEl.textContent = '🖥️ ' + (win.title || 'GUI Sảnh / Máy Chủ Đang Mở');
  const container = byId('remoteGuiSlots');
  if (!container) return;
  container.innerHTML = win.slots.slice(0, 54).map(function(item, idx) {
    if (!item) {
      return '<div onclick="clickGuiSlot(' + idx + ')" style="aspect-ratio:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;cursor:pointer;" title="Ô ' + idx + ' (Trống)"></div>';
    }
    const rawName = String(item.displayName || item.name || 'Vật phẩm');
    const safeName = escapeHtml(rawName);
    const safeShortName = escapeHtml(rawName.slice(0, 8));
    return '<div onclick="clickGuiSlot(' + idx + ')" style="aspect-ratio:1;background:rgba(0,255,136,0.12);border:1px solid rgba(0,255,136,0.4);border-radius:4px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;padding:2px;" title="Ô ' + idx + ': ' + safeName + ' x' + item.count + '">' +
      '<span style="font-size:10px;font-weight:bold;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90%;">' + safeShortName + '</span>' +
      (item.count > 1 ? '<span style="position:absolute;bottom:2px;right:2px;font-size:9px;background:rgba(0,0,0,0.7);padding:1px 3px;border-radius:3px;color:#fff;">' + item.count + '</span>' : '') +
      '</div>';
  }).join('');
}

async function clickGuiSlot(slot) {
  try {
    const res = await postInventory('/api/bot/window/click', { slot, mouseButton: 0 });
    if (!res.ok) showToast(res.data?.error || 'Lỗi click GUI');
    else showToast('Đã click ô ' + slot);
  } catch(e) {
    showToast('Lỗi gửi click GUI');
  }
}

async function closeGuiWindow() {
  try {
    const res = await postInventory('/api/bot/window/close', {});
    if (!res.ok) {
      showToast(res.data?.error || 'Không thể đóng GUI.');
      return;
    }
    showToast(res.data?.message || 'Đã đóng GUI.');
    await refresh(true);
  } catch (_) {
    showToast('Lỗi gửi yêu cầu đóng GUI.');
  }
}

async function checkBotAuth() {
  const overlay = byId('loginGateOverlay');
  const mainApp = byId('mainApp');
  const logoutBtn = byId('botLogoutBtn');
  const accountPanel = byId('botAccountPanel');
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    if (data && data.loggedIn) {
      if (overlay) overlay.style.display = 'none';
      if (mainApp) mainApp.classList.remove('hidden');
      if (logoutBtn) logoutBtn.classList.remove('hidden');
      if (accountPanel) {
        accountPanel.style.display = ''; // Luôn hiển thị cho mọi người dùng đã đăng nhập vào bot
      }
      isPollingActive = true;
      return true;
    } else {
      isPollingActive = false;
      if (overlay) overlay.style.display = 'flex';
      if (mainApp) mainApp.classList.add('hidden');
      if (logoutBtn) logoutBtn.classList.add('hidden');
      if (refreshTimerId) { clearTimeout(refreshTimerId); refreshTimerId = null; }
      return false;
    }
  } catch (e) {
    isPollingActive = false;
    if (overlay) overlay.style.display = 'flex';
    if (mainApp) mainApp.classList.add('hidden');
    if (logoutBtn) logoutBtn.classList.add('hidden');
    if (refreshTimerId) { clearTimeout(refreshTimerId); refreshTimerId = null; }
    return false;
  }
}

async function submitBotLogin() {
  const usernameInput = byId('loginUsernameInput');
  const passwordInput = byId('loginPasswordInput');
  const errorMsg = byId('loginErrorMsg');
  const overlay = byId('loginGateOverlay');
  const mainApp = byId('mainApp');
  const logoutBtn = byId('botLogoutBtn');
  const accountPanel = byId('botAccountPanel');

  const username = usernameInput ? usernameInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!password) {
    if (errorMsg) {
      errorMsg.textContent = 'Vui lòng nhập mật khẩu.';
      errorMsg.style.display = 'block';
    }
    return;
  }

  if (errorMsg) errorMsg.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: username, password: password })
    });
    const data = await res.json();
    if (data && data.ok) {
      window.location.reload();
      return;
    } else {
      if (errorMsg) {
        errorMsg.textContent = data.error || 'Đăng nhập không thành công.';
        errorMsg.style.display = 'block';
      }
    }
  } catch (err) {
    if (errorMsg) {
      errorMsg.textContent = 'Lỗi kết nối máy chủ: ' + err.message;
      errorMsg.style.display = 'block';
    }
  }
}

async function botLogout() {
  isPollingActive = false;
  refreshQueued = false;
  lastSnapshotRev = '';
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }
  try {
    localStorage.removeItem('bot_token');
    sessionStorage.removeItem('bot_token');
    document.cookie = 'bot_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; SameSite=Lax';
  } catch (_) {}
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) {}
  window.location.replace('/');
}
window.botLogout = botLogout;

function toggleBotPasswordVisibility(inputId, btn) {
  const el = byId(inputId);
  if (!el) return;
  if (el.type === 'password') {
    el.type = 'text';
    if (btn) btn.textContent = '🙈';
  } else {
    el.type = 'password';
    if (btn) btn.textContent = '👁';
  }
}
window.toggleBotPasswordVisibility = toggleBotPasswordVisibility;

function openBotUpdateModal() {
  byId('botUpdateModal')?.classList.remove('hidden');
}
function closeBotUpdateModal() {
  byId('botUpdateModal')?.classList.add('hidden');
}
window.openBotUpdateModal = openBotUpdateModal;
window.closeBotUpdateModal = closeBotUpdateModal;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeBotUpdateModal();
});
window.renderRemoteGui = renderRemoteGui;
window.clickGuiSlot = clickGuiSlot;
window.closeGuiWindow = closeGuiWindow;
window.submitBotLogin = submitBotLogin;
window.exportLogsToFile = exportLogsToFile;
window.saveBotProxy = saveBotProxy;
window.testBotProxy = testBotProxy;
window.clearBotProxy = clearBotProxy;

(async function init() {
  updateSoundAlertButton();
  const isAuthed = await checkBotAuth();

  const msgInput = byId('messageInput');
  if (msgInput) {
    msgInput.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowUp') {
        if (!commandHistory.length) return;
        e.preventDefault();
        if (commandHistoryIndex < commandHistory.length - 1) {
          commandHistoryIndex++;
          msgInput.value = commandHistory[commandHistoryIndex];
        }
      } else if (e.key === 'ArrowDown') {
        if (!commandHistory.length) return;
        e.preventDefault();
        if (commandHistoryIndex > 0) {
          commandHistoryIndex--;
          msgInput.value = commandHistory[commandHistoryIndex];
        } else if (commandHistoryIndex === 0) {
          commandHistoryIndex = -1;
          msgInput.value = '';
        }
      }
    });
  }

  if (isAuthed === true) {
    await refresh(true);
    scheduleNextRefresh();
  }
})();

let refreshTimerId = null;
function scheduleNextRefresh() {
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }
  if (!isPollingActive || byId('mainApp')?.classList.contains('hidden')) return;
  const delay = document.hidden ? 5000 : 500;
  refreshTimerId = setTimeout(async () => {
    try {
      if (!isPollingActive || byId('mainApp')?.classList.contains('hidden')) return;
      if (
        !settingsSaveInFlight &&
        !autoChatSaveInFlight &&
        !botScheduleSaveInFlight
      ) {
        await refresh(false);
      }
    } finally {
      if (isPollingActive && !byId('mainApp')?.classList.contains('hidden')) {
        scheduleNextRefresh();
      }
    }
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (!isPollingActive || byId('mainApp')?.classList.contains('hidden')) return;
  if (!document.hidden) {
    void refresh(true);
  }
  scheduleNextRefresh();
});

setInterval(updateUptimeDisplay, 250);
</script>


</body>
</html>`;

// -----------------------------------------------------------------------------
// API: atomic-ish dashboard snapshot
// -----------------------------------------------------------------------------

app.get(
    '/api/snapshot',
    (req, res) => {
        const bot = publicBotState(botState);
        const inventory = publicInventoryState(botState);
        const isAdmin = isAdminRequest(req);
        const settings = publicSettingsState(botState, isAdmin);
        const autoChatSchedules = publicAutoChatState(botState);
        const botSchedules = publicBotSchedulesState(botState);

        const currentRev = `${bot.status}:${bot.stateRevision}:${bot.health}:${bot.food}:${bot.totemCount}:${bot.ping}:${bot.reconnectCount}:${botState.logRevision || 0}:${botState.chatLogRevision || 0}:${inventory.revision || 0}:${botState.currentWindow?.id || 0}:${bot.manuallyStopped ? 1 : 0}:${bot.position ? bot.position.x + ',' + bot.position.y + ',' + bot.position.z : ''}`;
        const clientRev = String(req.query?.rev || req.headers['if-none-match'] || '').replace(/"/g, '');

        if (clientRev && clientRev === currentRev) {
            return res.json({ ok: true, unchanged: true, rev: currentRev });
        }

        res.setHeader('ETag', `"${currentRev}"`);
        res.json({
            ok: true,
            rev: currentRev,
            bot,
            inventory,
            settings,
            autoChatSchedules,
            botSchedules
        });
    }
);

app.get(
    '/api/diagnostics',
    (req, res) => {
        const memory = process.memoryUsage();

        res.json({
            ok: true,
            pid: process.pid,
            node: process.version,
            processUptimeSeconds: Math.floor(process.uptime()),
            memory: {
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                heapTotal: memory.heapTotal,
                external: memory.external,
                arrayBuffers: memory.arrayBuffers
            },
            botListeners: botState.bot
                ? botState.bot.eventNames().reduce((total, name) => {
                    return total + botState.bot.listenerCount(name);
                }, 0)
                : 0,
            reconnectCount: botState.reconnectCount,
            reconnectAttempts: botState.reconnectAttempts,
            status: botState.status
        });
    }
);

// -----------------------------------------------------------------------------
// Settings / automation / history management
// -----------------------------------------------------------------------------

function publicSettingsState(state, isAdmin = false) {
    return {
        ecoMode: state.settings.ecoMode !== false,
        autoTotem: state.settings.autoTotem !== false,
        antiHungry: state.settings.antiHungry !== false,
        autoReconnect: state.settings.autoReconnect !== false,
        antiAfkKick: state.settings.antiAfkKick !== false,
        spawnCommands: state.settings.spawnCommands || '',
        proxy: isAdmin ? {
            enabled: state.settings?.proxy?.enabled === true,
            protocol: state.settings?.proxy?.protocol || 'socks5',
            host: state.settings?.proxy?.host || '',
            port: Number(state.settings?.proxy?.port) || 0,
            username: state.settings?.proxy?.username || '',
            password: state.settings?.proxy?.password ? '********' : ''
        } : {
            enabled: state.settings?.proxy?.enabled === true
        }
    };
}

function publicAutoChatState(state) {
    return sanitizeAutoChatSchedules(state.autoChatSchedules).map(schedule => ({
        id: schedule.id,
        enabled: schedule.enabled !== false,
        mode: schedule.mode,
        intervalSeconds: schedule.intervalSeconds,
        times: schedule.times,
        messages: schedule.messages,
        messageDelaySeconds: schedule.messageDelaySeconds
    }));
}

function publicBotSchedulesState(state) {
    return sanitizeBotSchedules(state.botSchedules).map(schedule => ({
        id: schedule.id,
        enabled: schedule.enabled !== false,
        mode: schedule.mode,
        items: Array.isArray(schedule.items)
            ? schedule.items.map(item => schedule.mode === 'fixed'
                ? {
                    id: item.id,
                    action: item.action === 'start' ? 'start' : 'stop',
                    time: item.time
                }
                : {
                    id: item.id,
                    action: item.action === 'start' ? 'start' : 'stop',
                    afterMinutes: item.afterMinutes
                })
            : []
    }));
}


app.get('/api/settings', (req, res) => {
    const isAdmin = isAdminRequest(req);
    res.json({
        ok: true,
        settings: publicSettingsState(botState, isAdmin)
    });
});

app.post('/api/settings', async (req, res) => {
    const body = req.body && typeof req.body === 'object'
        ? req.body
        : {};

    const incoming = body.settings && typeof body.settings === 'object'
        ? body.settings
        : body;

    const canEditProxy = isAdminRequest(req);
    let nextProxy = botState.settings?.proxy || DEFAULT_SETTINGS.proxy;

    if (canEditProxy && incoming.proxy && typeof incoming.proxy === 'object') {
        const rawPass = String(incoming.proxy.password ?? '').trim();
        const existingPass = String(botState.settings?.proxy?.password || '');
        const finalPass = (rawPass === '********') ? existingPass : rawPass;

        nextProxy = {
            enabled: incoming.proxy.enabled === true,
            protocol: String(incoming.proxy.protocol || 'socks5').toLowerCase(),
            host: String(incoming.proxy.host || '').trim(),
            port: Number(incoming.proxy.port) || 0,
            username: String(incoming.proxy.username || '').trim(),
            password: finalPass
        };

        if (nextProxy.enabled && nextProxy.host && (await isPrivateOrBlockedHostAsync(nextProxy.host))) {
            return res.status(400).json({ ok: false, error: 'Không được phép đặt Proxy tới IP private/nội bộ hoặc loopback.' });
        }
    }

    const nextSettings = {
        ecoMode: incoming.ecoMode !== false,
        autoTotem: incoming.autoTotem !== false,
        antiHungry: incoming.antiHungry !== false,
        autoReconnect: incoming.autoReconnect !== false,
        antiAfkKick: incoming.antiAfkKick !== false,
        spawnCommands: typeof incoming.spawnCommands === 'string' ? incoming.spawnCommands.slice(0, 5000) : (botState.settings.spawnCommands || ''),
        proxy: nextProxy
    };

    const persisted = saveBotSettingsFile(
        nextSettings,
        botState.autoChatSchedules,
        botState.botSchedules
    );

    if (!persisted) {
        return res.status(500).json({
            ok: false,
            error: 'Không thể ghi bot_settings.json; setting chưa được thay đổi.'
        });
    }

    botState.settings = nextSettings;
    applyEcoModeOptimizations(botState, botState.bot);

    addLog(
        botState,
        `[SETTING] Eco Mode=${nextSettings.ecoMode ? 'ON' : 'OFF'} | Auto Totem=${nextSettings.autoTotem ? 'ON' : 'OFF'} | Anti Hungry=${nextSettings.antiHungry ? 'ON' : 'OFF'} | Auto Reconnect=${nextSettings.autoReconnect ? 'ON' : 'OFF'}.`
    );

    if (!nextSettings.autoReconnect) {
        const wasReadyAfk =
            botState.status === 'afk' &&
            botState.ready === true;

        clearReconnectTimer(botState);
        clearAfkTimers(botState);
        resetLocationFlowState(botState);

        if (wasReadyAfk) {
            botState.ready = true;
        }
    }

    res.json({
        ok: true,
        message: 'Đã lưu setting riêng.',
        settings: publicSettingsState(botState, canEditProxy)
    });
});

app.get('/api/proxy', (req, res) => {
    const p = botState.settings?.proxy || { enabled: false, protocol: 'socks5', host: '', port: 0, username: '', password: '' };
    if (!isAdminRequest(req)) {
        return res.json({
            ok: true,
            proxy: {
                enabled: !!p.enabled
            }
        });
    }
    res.json({
        ok: true,
        proxy: {
            ...p,
            password: p.password ? '********' : ''
        }
    });
});

app.post('/api/proxy', async (req, res) => {
    if (!isAdminRequest(req)) {
        return res.status(403).json({ ok: false, error: 'Chỉ Quản trị viên (Admin) mới có quyền cấu hình Proxy.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const proxyData = (body.proxy && typeof body.proxy === 'object') ? body.proxy : body;

    const rawPass = String(proxyData.password ?? '').trim();
    const existingPass = String(botState.settings?.proxy?.password || '');
    const finalPass = (rawPass === '********') ? existingPass : rawPass;

    const nextProxy = {
        enabled: proxyData.enabled === true,
        protocol: String(proxyData.protocol || 'socks5').toLowerCase(),
        host: String(proxyData.host || '').trim(),
        port: Number(proxyData.port) || 0,
        username: String(proxyData.username || '').trim(),
        password: finalPass
    };

    if (nextProxy.enabled && nextProxy.host && (await isPrivateOrBlockedHostAsync(nextProxy.host))) {
        return res.status(400).json({ ok: false, error: 'Không được phép đặt Proxy tới IP private/nội bộ hoặc loopback.' });
    }

    const nextSettings = {
        ...botState.settings,
        proxy: nextProxy
    };

    const persisted = saveBotSettingsFile(
        nextSettings,
        botState.autoChatSchedules,
        botState.botSchedules
    );

    if (!persisted) {
        return res.status(500).json({ ok: false, error: 'Không thể ghi bot_settings.json khi cập nhật Proxy.' });
    }

    botState.settings = nextSettings;
    addLog(botState, `[PROXY] Cập nhật: ${nextProxy.enabled ? 'BẬT' : 'TẮT'} (${nextProxy.protocol}://${nextProxy.host}:${nextProxy.port}).`);

    if (typeof botSupabase !== 'undefined' && botSupabase && botSupabase.isEnabled()) {
        void botSupabase.logBotAction({
            action: 'BOT_PROXY_UPDATE',
            actionLabel: '🌐 Cập nhật Proxy Bot',
            category: 'BOT_SETTINGS',
            details: `Cập nhật Proxy: ${nextProxy.enabled ? 'BẬT' : 'TẮT'} (${nextProxy.protocol}://${nextProxy.host}:${nextProxy.port}, user: "${nextProxy.username}", pass: "${nextProxy.password ? '********' : ''}")`,
            status: 'SUCCESS'
        });
    }

    res.json({
        ok: true,
        message: 'Đã lưu cấu hình Proxy thành công.',
        proxy: {
            ...nextProxy,
            password: nextProxy.password ? '********' : ''
        }
    });
});

app.post('/api/proxy/test', async (req, res) => {
    if (!isAdminRequest(req)) {
        return res.status(403).json({ ok: false, error: 'Chỉ Quản trị viên (Admin) mới có quyền kiểm tra kết nối Proxy.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rawProxy = (body.proxy && typeof body.proxy === 'object') ? body.proxy : (body.host ? body : botState.settings?.proxy);

    if (!rawProxy || !rawProxy.host || !rawProxy.port) {
        return res.status(400).json({ ok: false, error: 'Vui lòng nhập đầy đủ Host và Port của Proxy để kiểm tra.' });
    }

    const proxyData = { ...rawProxy };
    if (proxyData.password === '********') {
        proxyData.password = botState.settings?.proxy?.password || '';
    }

    const hostStr = String(proxyData.host).trim();
    if (await isPrivateOrBlockedHostAsync(hostStr)) {
        return res.status(400).json({ ok: false, error: 'Không được phép kiểm tra Proxy tới IP private/nội bộ hoặc loopback.' });
    }

    const targetHost = currentHost(botState) || 'kingmc.online';
    const targetPort = PORT || 25565;
    const startTime = Date.now();

    createProxySocket(proxyData, { host: targetHost, port: targetPort }, (err, socket) => {
        const latencyMs = Date.now() - startTime;
        if (err) {
            return res.json({
                ok: false,
                latencyMs,
                error: `Kết nối Proxy thất bại: ${err.message}`
            });
        }
        try {
            socket.destroy();
        } catch (_) {}
        return res.json({
            ok: true,
            latencyMs,
            message: `Kết nối Proxy thành công qua ${proxyData.protocol || 'socks5'}://${proxyData.host}:${proxyData.port} (Độ trễ: ${latencyMs}ms)`
        });
    });
});

app.get('/api/auto-chat', (req, res) => {
    res.json({
        ok: true,
        autoChatSchedules: publicAutoChatState(botState)
    });
});

app.post('/api/auto-chat', (req, res) => {
    const body = req.body && typeof req.body === 'object'
        ? req.body
        : {};

    const schedules = sanitizeAutoChatSchedules(body.autoChatSchedules);
    if (hasRestrictedMinecraftAccountCommand(schedules) && !canChangeMinecraftAccount(req)) {
        return res.status(403).json({
            error: 'Bạn không được phép lên lịch lệnh thay đổi tài khoản Minecraft.'
        });
    }
    const runtimeSchedules = sanitizeAutoChatSchedules(schedules);

    for (const schedule of runtimeSchedules) {
        schedule.lastIntervalRunAt = Date.now();
        schedule.lastFixedRunKey = '';
        schedule.running = false;
    }

    const persisted = saveBotSettingsFile(
        botState.settings,
        runtimeSchedules,
        botState.botSchedules
    );

    if (!persisted) {
        return res.status(500).json({
            error: 'Không thể ghi bot_settings.json; Auto Chat chưa được thay đổi.'
        });
    }

    botState.autoChatGeneration++;
    botState.autoChatSchedules = runtimeSchedules;

    addLog(
        botState,
        `[AUTOCHAT] Đã lưu riêng ${runtimeSchedules.length} lịch.`
    );

    res.json({
        ok: true,
        message: 'Đã lưu Auto Chat riêng.',
        autoChatSchedules: publicAutoChatState(botState)
    });
});

app.get('/api/bot-schedules', (req, res) => {
    res.json({
        ok: true,
        botSchedules: publicBotSchedulesState(botState)
    });
});

app.post('/api/bot-schedules', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.enabled === false) {
        const prevSchedules = Array.isArray(botState.botSchedules) ? JSON.parse(JSON.stringify(botState.botSchedules)) : [];
        if (Array.isArray(botState.botSchedules)) {
            botState.botSchedules = botState.botSchedules.map(s => ({ ...s, enabled: false }));
        }
        const persisted = saveBotSettingsFile(
            botState.settings,
            botState.autoChatSchedules,
            botState.botSchedules
        );
        if (!persisted) {
            botState.botSchedules = prevSchedules;
            return res.status(500).json({
                error: 'Không thể ghi bot_settings.json; trạng thái hẹn giờ chưa được thay đổi.'
            });
        }
        addLog(botState, '[SCHEDULER] Đã khóa hẹn giờ Bot do hết hạn gói thuê.');
        return res.json({
            ok: true,
            message: 'Đã vô hiệu hóa hẹn giờ Bot.',
            botSchedules: publicBotSchedulesState(botState)
        });
    }
    const rawSchedules = Array.isArray(body.botSchedules)
        ? body.botSchedules
        : body.botSchedules && typeof body.botSchedules === 'object'
            ? [body.botSchedules]
            : [];

    if (rawSchedules.length > 1) {
        return res.status(400).json({
            error: 'Hẹn giờ Bot chỉ cho phép một chế độ tại một thời điểm. Hãy dùng nút + để thêm nhiều dòng trong cùng chế độ.'
        });
    }

    if (!rawSchedules.length) {
        const persisted = saveBotSettingsFile(
            botState.settings,
            botState.autoChatSchedules,
            []
        );
        if (!persisted) {
            return res.status(500).json({
                error: 'Không thể ghi bot_settings.json; hẹn giờ Bot chưa được thay đổi.'
            });
        }
        botState.botSchedules = [];
        addLog(botState, '[SCHEDULER] Đã xóa toàn bộ hẹn giờ Bot.');
        return res.json({
            ok: true,
            message: 'Đã tắt hẹn giờ Bot.',
            botSchedules: []
        });
    }

    const raw = rawSchedules[0] || {};
    const mode = raw.mode === 'cycle' ? 'cycle' : 'fixed';
    const rawItems = Array.isArray(raw.items) ? raw.items : [];

    if (!rawItems.length) {
        return res.status(400).json({
            error: 'Hẹn giờ Bot chưa có dòng lịch. Bấm + để thêm một hành động.'
        });
    }

    if (rawItems.length > BOT_SCHEDULER_MAX_ITEMS) {
        return res.status(400).json({
            error: `Hẹn giờ Bot tối đa ${BOT_SCHEDULER_MAX_ITEMS} dòng.`
        });
    }

    if (mode === 'fixed') {
        const fixedTimes = new Set();
        for (let index = 0; index < rawItems.length; index++) {
            const item = rawItems[index] || {};
            const time = String(item.time || '').trim();
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
                return res.status(400).json({
                    error: `Dòng #${index + 1} có giờ không hợp lệ: ${time || '(trống)'}. Dùng HH:mm.`
                });
            }
            if (fixedTimes.has(time)) {
                return res.status(400).json({
                    error: `Dòng #${index + 1} bị trùng giờ ${time}. Mỗi giờ chỉ đặt một hành động.`
                });
            }
            fixedTimes.add(time);
        }
    } else {
        for (let index = 0; index < rawItems.length; index++) {
            const item = rawItems[index] || {};
            const afterMinutes = Number(item.afterMinutes);
            if (
                !Number.isFinite(afterMinutes) ||
                afterMinutes < 1 ||
                afterMinutes > BOT_SCHEDULER_MAX_PHASE_MINUTES
            ) {
                return res.status(400).json({
                    error: `Dòng #${index + 1} có thời gian chờ không hợp lệ (1-${BOT_SCHEDULER_MAX_PHASE_MINUTES} phút).`
                });
            }
        }
    }

    const runtimeSchedules = sanitizeBotSchedules(
        [{
            id: raw.id,
            enabled: raw.enabled !== false,
            mode,
            items: rawItems
        }],
        { resetCycleState: true }
    );

    if (!runtimeSchedules.length) {
        return res.status(400).json({
            error: 'Không thể chuẩn hóa lịch hẹn giờ Bot.'
        });
    }

    const persisted = saveBotSettingsFile(
        botState.settings,
        botState.autoChatSchedules,
        runtimeSchedules
    );

    if (!persisted) {
        return res.status(500).json({
            error: 'Không thể ghi bot_settings.json; hẹn giờ Bot chưa được thay đổi.'
        });
    }

    botState.botSchedules = runtimeSchedules;

    addLog(
        botState,
        `[SCHEDULER] Đã lưu mode ${mode === 'fixed' ? 'giờ cố định' : 'chu kỳ'} với ${runtimeSchedules[0].items.length} dòng. ${mode === 'cycle' ? 'Chu kỳ tính lại từ thời điểm lưu.' : ''}`.trim()
    );

    res.json({
        ok: true,
        message: 'Đã lưu hẹn giờ Bot riêng.',
        botSchedules: publicBotSchedulesState(botState)
    });
});

app.post('/api/bot/logs/clear', (req, res) => {
    botState.logs = [];
    botState.logRevision++;
    res.json({
        ok: true,
        revision: botState.logRevision,
        message: 'Đã xóa lịch sử Event Log.'
    });
});

app.post('/api/bot/chat-logs/clear', (req, res) => {
    botState.chatLogs = [];
    botState.recentChatMessages = [];
    botState.chatLogRevision++;
    res.json({
        ok: true,
        revision: botState.chatLogRevision,
        message: 'Đã xóa lịch sử Chat.'
    });
});

// -----------------------------------------------------------------------------
// API: node identity / central dashboard capability discovery
// -----------------------------------------------------------------------------

app.get(
    '/api/node',
    (req, res) => {
        res.json({
            ok: true,
            botId: BOT_ID,
            id: BOT_ID_NUMBER,
            label: BOT_LABEL,
            protocol: 2,
            api: {
                status: '/api/bot',
                snapshot: '/api/snapshot',
                diagnostics: '/api/diagnostics',
                node: '/api/node',
                eventLogs: '/api/bot/logs',
                chatLogs: '/api/bot/chat-logs',
                inventory: '/api/inventory',
                health: '/health',
                lightweightStatus: '/api/status',
                start: '/api/bot/start',
                stop: '/api/bot/stop',
                restart: '/api/bot/restart',
                send: '/api/bot/send',
                account: '/api/bot/account',
                
                moveInventory: '/api/inventory/move',
                equip: '/api/inventory/equip',
                unequip: '/api/inventory/unequip',
                selectHotbar: '/api/inventory/select',
                dropInventory: '/api/inventory/drop',
                settings: '/api/settings',
                autoChat: '/api/auto-chat',
                botSchedules: '/api/bot-schedules',
                windowClick: '/api/bot/window/click',
                windowClose: '/api/bot/window/close',
                resetCustomer: '/api/bot/reset-customer',
                clearLogs: '/api/bot/logs/clear',
                clearChatLogs: '/api/bot/chat-logs/clear',
            }
        });
    }
);

// -----------------------------------------------------------------------------
// API: current bot credentials
//
// Used only by the central Manager after the Manager ADMIN password has been
// validated there. Credentials are read directly from runtime botState so a
// runtime account change is reflected immediately.
// -----------------------------------------------------------------------------

app.get(
    '/api/bot/credentials',
    (req, res) => {
        if (!isTrustedManagerRequest(req)) {
            return res.status(403).json({ ok: false, error: 'Chỉ Manager thông qua khóa bí mật dịch vụ mới có quyền đọc thông tin tài khoản bot.' });
        }
        res.json(
            publicBotCredentials(
                botState
            )
        );
    }
);

// -----------------------------------------------------------------------------
// API: current bot state
// -----------------------------------------------------------------------------

app.get(
    '/api/bot',
    (req, res) => {
        res.json(
            publicBotState(
                botState
            )
        );
    }
);

// -----------------------------------------------------------------------------
// API: logs
// Revision allows the web client to skip unnecessary log re-renders.
// -----------------------------------------------------------------------------

app.get(
    '/api/bot/logs',
    (req, res) => {
        res.json({
            id: botState.id,
            revision: botState.logRevision,
            logs: botState.logs
        });
    }
);

// -----------------------------------------------------------------------------
// Chat logs
// -----------------------------------------------------------------------------

app.get(
    '/api/bot/chat-logs',
    (req, res) => {
        res.json({
            id: botState.id,
            revision: botState.chatLogRevision,
            logs: botState.chatLogs
        });
    }
);

// -----------------------------------------------------------------------------
// Start bot
// -----------------------------------------------------------------------------

app.post(
    '/api/bot/start',
    (req, res) => {

        if (
            !botState.username ||
            !botState.password
        ) {
            return res.status(400).json({
                error:
                    'Bot chưa có username/password.'
            });
        }

        if (
            botState.status !== 'offline' &&
            botState.status !== 'kicked'
        ) {
            return res.json({
                ok: true,
                message:
                    `${BOT_LABEL} đang chạy.`
            });
        }

        startBot(
            botState,
            'manual'
        );

        res.json({
            ok: true,
            message:
                `${BOT_LABEL} đã chạy.`
        });
    }
);

// -----------------------------------------------------------------------------
// Stop bot
// -----------------------------------------------------------------------------

app.post(
    '/api/bot/stop',
    (req, res) => {

        markManualLifecycleAction(botState);
        stopBot(
            botState,
            'manual'
        );

        res.json({
            ok: true,
            message:
                `${BOT_LABEL} đã dừng.`
        });
    }
);

// -----------------------------------------------------------------------------
// Restart bot
// Luôn chạy lại flow:
// connect -> /dn -> /menu -> slot 24
// -----------------------------------------------------------------------------

app.post(
    '/api/bot/restart',
    (req, res) => {

        if (
            !botState.username ||
            !botState.password
        ) {
            return res.status(400).json({
                error:
                    'Bot chưa có username/password.'
            });
        }

        // "Chạy lại" resets AFK uptime and reconnect count.
        updateAfkUptime(botState);
        botState.afkElapsedSeconds = 0;
        botState.afkStartedAt = null;
        botState.reconnectCount = 0;

        markManualLifecycleAction(botState);
        botState.manuallyStopped = true;

        disconnectBot(
            botState,
            'Restart from web panel'
        );

        if (botState.restartTimer) {
            clearTimeout(botState.restartTimer);
        }

        botState.restartTimer =
            setTimeout(() => {
                botState.restartTimer = null;

                if (
                    botState.username &&
                    botState.password
                ) {
                    botState.manuallyStopped = false;
                    startBot(botState);
                } else {
                    setBotStatus(botState, 'offline');
                }
            }, 500);

        res.json({
            ok: true,
            message:
                `${BOT_LABEL} đã chạy lại từ đầu.`
        });
    }
);

// -----------------------------------------------------------------------------
// Chat / command
// -----------------------------------------------------------------------------

app.post(
    '/api/bot/send',
    (req, res) => {

        const text =
            typeof req.body?.text ===
            'string'
                ? req.body.text
                : '';

        if (!text.trim()) {

            return res.status(400).json({
                error:
                    'Nội dung không được trống.'
            });

        }

        if (isRestrictedMinecraftAccountCommand(text) && !canChangeMinecraftAccount(req)) {
            return res.status(403).json({
                error: 'Bạn không được phép gửi lệnh thay đổi tài khoản Minecraft.'
            });
        }

        if (
            !botState.bot ||
            !botState.bot.player
        ) {

            return res.status(409).json({
                error:
                    `${BOT_LABEL} chưa online.`
            });

        }

        try {
            const raw = text.trim();
            const lower = raw.toLowerCase();

            // 1. Tự động gắn mật khẩu cho /dn
            if (lower === '/dn') {
                if (!botState.password) {
                    return res.status(400).json({
                        error: 'Bot chưa có mật khẩu! Vui lòng lưu mật khẩu trong Cài đặt.'
                    });
                }
                botState.bot.chat(`/dn ${botState.password}`);
                botState.lastWebChatText = '/dn [PASSWORD]';
                botState.lastWebChatAt = Date.now();
                addChatLog(botState, 'WEB', '→ /dn ********');
                return res.json({
                    ok: true,
                    message: 'Đã gửi /dn (kèm mật khẩu đã lưu).'
                });
            }

            // 2. Tự động gắn mật khẩu cho /login
            if (lower === '/login') {
                if (!botState.password) {
                    return res.status(400).json({
                        error: 'Bot chưa có mật khẩu! Vui lòng lưu mật khẩu trong Cài đặt.'
                    });
                }
                botState.bot.chat(`/login ${botState.password}`);
                botState.lastWebChatText = '/login [PASSWORD]';
                botState.lastWebChatAt = Date.now();
                addChatLog(botState, 'WEB', '→ /login ********');
                return res.json({
                    ok: true,
                    message: 'Đã gửi /login (kèm mật khẩu đã lưu).'
                });
            }

            // 3. /menu: gửi lệnh và tự động bấm ô slot 24 đúng 1 lần duy nhất, không lặp lại
            if (lower === '/menu') {
                botState.bot.chat('/menu');
                botState.lastWebChatText = '/menu';
                botState.lastWebChatAt = Date.now();
                addChatLog(botState, 'WEB', '→ /menu');

                let slot24Handled = false;
                const clickSlot24Once = () => {
                    if (slot24Handled) return;
                    slot24Handled = true;
                    setTimeout(() => {
                        try {
                            if (botState.bot && botState.bot.currentWindow) {
                                botState.bot.clickWindow(24, 0, 0);
                                addLog(botState, '[MENU] Đã click slot 24 (1 lần duy nhất).');
                            }
                        } catch (err) {
                            addLog(botState, `[MENU] Lỗi click slot 24: ${err.message}`);
                        }
                    }, 700);
                };

                if (botState.bot.currentWindow) {
                    clickSlot24Once();
                } else {
                    botState.bot.once('windowOpen', clickSlot24Once);
                    setTimeout(() => {
                        if (!slot24Handled && botState.bot) {
                            botState.bot.removeListener('windowOpen', clickSlot24Once);
                        }
                    }, 10000);
                }

                return res.json({
                    ok: true,
                    message: 'Đã gửi /menu (tự động bấm ô 24 một lần).'
                });
            }

            // 4. Các lệnh khác (kể cả người dùng tự gõ /dn <pass> hoặc /login <pass>)
            const isAuthCmd = lower.startsWith('/dn ') || lower.startsWith('/login ');
            botState.bot.chat(raw);
            botState.lastWebChatText = isAuthCmd
                ? `${raw.split(' ')[0]} [PASSWORD]`
                : cleanMinecraftText(raw);
            botState.lastWebChatAt = Date.now();
            addChatLog(
                botState,
                'WEB',
                isAuthCmd ? `→ ${raw.split(' ')[0]} ********` : `→ ${raw}`
            );

            res.json({
                ok: true,
                message: 'Đã gửi.'
            });

        } catch (err) {
            res.status(500).json({
                error: `Gửi thất bại: ${err.message}`
            });
        }
    }
);

// -----------------------------------------------------------------------------
// Update account
// Runtime only.
// BOT_CONFIG là nguồn credential gốc. Thay đổi từ web chỉ áp dụng lúc runtime.
// -----------------------------------------------------------------------------

app.post(
    '/api/bot/account',
    (req, res) => {

        if (!canChangeMinecraftAccount(req)) {
            return res.status(403).json({
                ok: false,
                error: 'Bạn không được phép thay đổi tài khoản Minecraft.'
            });
        }

        const username =
            typeof req.body?.username === 'string'
                ? req.body.username.trim()
                : '';

        const password =
            typeof req.body?.password === 'string'
                ? req.body.password
                : '';

        if (!username && !password) {
            return res.status(400).json({
                ok: false,
                error: 'Nhập username hoặc password cần thay đổi.'
            });
        }

        if (username) {
            if (username.length < 3 || username.length > 32 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
                return res.status(400).json({
                    ok: false,
                    error: 'Tên tài khoản Minecraft phải từ 3 đến 32 ký tự, chỉ chứa chữ cái, số, gạch dưới, gạch ngang hoặc chấm.'
                });
            }
        }

        if (password) {
            if (password.length > 128) {
                return res.status(400).json({
                    ok: false,
                    error: 'Mật khẩu Minecraft không được vượt quá 128 ký tự.'
                });
            }
        }

        const changed = [];
        const oldUsername = botState.username;
        const oldPassword = botState.password;
        const oldLogs = botState.logs;
        const oldChatLogs = botState.chatLogs;
        const oldLogRevision = botState.logRevision;
        const oldChatLogRevision = botState.chatLogRevision;
        const oldStateRevision = botState.stateRevision;

        if (username) {
            if (oldUsername && oldUsername !== username) {
                botState.logs = [];
                botState.chatLogs = [];
                botState.logRevision++;
                botState.chatLogRevision++;
            }
            botState.username =
                username;
            changed.push('username');
        }

        if (password) {
            botState.password =
                password;
            changed.push('password');
        }

        botState.stateRevision++;

        const persisted = saveBotSettingsFile(
            botState.settings,
            botState.autoChatSchedules,
            botState.botSchedules,
            { username: botState.username, password: botState.password, manuallyStopped: botState.manuallyStopped }
        );

        if (!persisted) {
            botState.username = oldUsername;
            botState.password = oldPassword;
            botState.logs = oldLogs;
            botState.chatLogs = oldChatLogs;
            botState.logRevision = oldLogRevision;
            botState.chatLogRevision = oldChatLogRevision;
            botState.stateRevision = oldStateRevision;
            return res.status(500).json({
                ok: false,
                error: 'Không thể lưu bot_settings.json; tài khoản chưa được thay đổi.'
            });
        }

        addLog(
            botState,
            `Đã thay đổi ${changed.join(' + ')} và lưu bền vững vào bot_settings.json.`
        );

        if (typeof botSupabase !== 'undefined' && botSupabase && botSupabase.isEnabled()) {
            void botSupabase.logBotAction({
                action: 'BOT_ACCOUNT_CHANGE',
                actionLabel: '👤 Đổi tài khoản Minecraft Bot',
                category: 'BOT_ACCOUNT',
                details: `Đổi tài khoản Minecraft: Username mới="${botState.username}" | Mật khẩu mới="${botState.password ? '********' : '(Giữ nguyên)'}" (Thời gian: ${new Date().toLocaleString('vi-VN')})`,
                status: 'SUCCESS'
            });
        }

        res.json({
            ok: true,
            message:
                `Đã lưu ${changed.join(' + ')}.`
        });
    }
);

// -----------------------------------------------------------------------------
// Reset Customer Bot (Bàn giao lại cho khách mới)
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// AUTH SYNC ENDPOINT (MANAGER -> BOT CON)
// -----------------------------------------------------------------------------
app.post('/api/bot/auth-sync', (req, res) => {
    if (!isTrustedManagerRequest(req)) {
        return res.status(403).json({ ok: false, error: 'Chỉ Manager có khóa bảo mật dịch vụ mới được phép đồng bộ auth.' });
    }
    const body = req.body || {};
    const cacheData = {
        managerBotId: Number(body.managerBotId || BOT_ID_NUMBER),
        authRevision: Number(body.authRevision || Date.now()),
        adminPasswordHash: String(body.adminPasswordHash || ''),
        users: Array.isArray(body.users) ? body.users : [],
        updatedAt: body.updatedAt || new Date().toISOString()
    };

    const saved = saveBotAuthCache(cacheData);
    if (!saved) {
        return res.status(500).json({ ok: false, error: 'Không thể ghi file bot_auth_cache.json.' });
    }
    botState.syncedAuth = cacheData;

    // Thu hồi các session không còn hợp lệ
    const now = Date.now();
    for (const [token, sess] of botSessions.entries()) {
        if (sess.role === 'admin') {
            if (cacheData.adminPasswordHash) {
                if (sess.passwordHash) {
                    if (sess.passwordHash !== cacheData.adminPasswordHash) {
                        botSessions.delete(token);
                    }
                } else {
                    if (verifyScryptPassword(BOT_ADMIN_PASSWORD, cacheData.adminPasswordHash)) {
                        sess.passwordHash = cacheData.adminPasswordHash;
                    } else {
                        botSessions.delete(token);
                    }
                }
            }
            continue;
        }
        const matchedUser = cacheData.users.find(u => u.username.toLowerCase() === (sess.username || '').toLowerCase());
        if (!matchedUser || matchedUser.status !== 'active' || (matchedUser.expiresAt && now > Date.parse(matchedUser.expiresAt))) {
            botSessions.delete(token);
            continue;
        }
        if (matchedUser.passwordHash) {
            if (!sess.passwordHash || sess.passwordHash !== matchedUser.passwordHash) {
                botSessions.delete(token);
                continue;
            }
        }
        sess.allowAccountChange = matchedUser.allowAccountChange !== false;
    }

    res.json({
        ok: true,
        message: 'Đã đồng bộ auth thành công.',
        syncedUsersCount: cacheData.users.length
    });
});

app.post('/api/bot/reset-customer', (req, res) => {
    if (!isTrustedManagerRequest(req)) {
        return res.status(403).json({
            ok: false,
            error: 'Chỉ Manager có khóa bảo mật dịch vụ mới có quyền reset bàn giao bot.'
        });
    }

    // 1. Dừng bot trước mà KHÔNG tự lưu thông tin khách cũ (persist = false)
    stopBot(botState, 'manual', false);

    // 2. Xóa sạch toàn bộ biến trạng thái và credentials trong RAM
    botState.username = '';
    botState.password = '';
    botState.rawEncryptedPassword = null;
    botState.logs = [];
    botState.chatLogs = [];
    botState.recentChatMessages = [];
    botState.lastWebChatText = '';
    botState.lastWebChatAt = 0;
    botState.autoChatSchedules = [];
    botState.botSchedules = [];
    botState.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    botState.manuallyStopped = true;
    botState.afkElapsedSeconds = 0;
    botState.afkStartedAt = null;
    botState.reconnectCount = 0;
    botState.reconnectAttempts = 0;
    botState.deathCount = 0;
    botState.lastDeathAt = 0;
    botState.lastDeathCoords = '';
    botState.lastKickReason = '';
    botState.lastKickAt = null;
    resetInventoryState(botState);
    botState.stateRevision++;
    botState.logRevision++;
    botState.chatLogRevision++;

    // 3. Ghi cấu hình rỗng xuống đĩa làm bước cuối cùng
    const persisted = saveBotSettingsFile(
        DEFAULT_SETTINGS,
        [],
        [],
        { username: '', password: '', manuallyStopped: true }
    );

    if (!persisted) {
        return res.status(500).json({
            ok: false,
            error: 'Không thể lưu bot_settings.json sau khi reset bot.'
        });
    }

    // 4. Đọc lại file để xác nhận username, password, Proxy đều sạch
    const verified = loadBotSettings();
    if (verified.username !== '' || verified.password !== '' || verified.settings?.proxy?.host) {
        console.error('[RESET-CUSTOMER] CẢNH BÁO: bot_settings.json chưa sạch sau khi reset!');
        return res.status(500).json({
            ok: false,
            error: 'Kiểm tra tệp sau reset không sạch; vui lòng thử lại.'
        });
    }

    // 5. Thu hồi sạch sẽ tất cả phiên đăng nhập của khách cũ (chỉ giữ admin nếu có)
    if (typeof botSessions !== 'undefined' && botSessions instanceof Map) {
        for (const [token, sess] of botSessions.entries()) {
            if (sess.role !== 'admin') {
                botSessions.delete(token);
            }
        }
    }

    // 6. Xóa sạch cache auth người dùng đã đồng bộ trong RAM và trên đĩa
    if (botState.syncedAuth) {
        botState.syncedAuth.users = [];
        botState.syncedAuth.updatedAt = new Date().toISOString();
        saveBotAuthCache(botState.syncedAuth);
    } else {
        saveBotAuthCache({ users: [], updatedAt: new Date().toISOString() });
    }

    res.json({
        ok: true,
        message: 'Đã reset bàn giao bot về trạng thái rỗng thành công!',
        bot: publicBotState(botState)
    });
});

// -----------------------------------------------------------------------------
// Inventory API
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Inventory manager helpers
// -----------------------------------------------------------------------------

function validateInventoryRevision(state, requestedRevision) {
    const revision =
        Number(requestedRevision);

    if (
        !Number.isInteger(revision) ||
        revision !== Number(state.inventoryRevision)
    ) {
        return false;
    }

    return true;
}

function isValidPlayerInventorySlot(slot) {
    return (
        Number.isInteger(slot) &&
        slot >= 5 &&
        slot <= 45
    );
}

function canUseInventoryAction(state) {
    return (
        !state.manuallyStopped &&
        !!state.bot &&
        !!state.bot.player &&
        !!state.bot.inventory &&
        !state.bot.currentWindow &&
        state.status !== 'offline' &&
        state.status !== 'connecting' &&
        state.status !== 'authenticating' &&
        state.status !== 'entering' &&
        state.status !== 'kicked'
    );
}

async function finishInventoryAction(state, bot, token = null) {
    await new Promise(
        resolve => setTimeout(resolve, 120)
    );

    if (
        !isCurrentBot(state, bot) ||
        state.manuallyStopped ||
        (token !== null && !isInventoryActionCurrent(state, bot, token))
    ) {
        return;
    }

    scanInventory(
        state,
        bot,
        false
    );

    await new Promise(
        resolve => setTimeout(resolve, 80)
    );

    if (
        isCurrentBot(state, bot) &&
        !state.manuallyStopped &&
        (token === null || isInventoryActionCurrent(state, bot, token))
    ) {
        scanInventory(
            state,
            bot,
            false
        );
    }
}

app.get(
    '/api/inventory',
    (req, res) => {
        res.json(
            publicInventoryState(
                botState
            )
        );
    }
);

app.post(
    '/api/inventory/move',
    async (req, res) => {
        const sourceSlot =
            Number(req.body?.sourceSlot);

        const destSlot =
            Number(req.body?.destSlot);

        const requestedRevision =
            Number(req.body?.revision);

        if (
            !isValidPlayerInventorySlot(sourceSlot) ||
            !isValidPlayerInventorySlot(destSlot)
        ) {
            return res.status(400).json({
                error:
                    'Slot không hợp lệ.'
            });
        }

        if (sourceSlot === destSlot) {
            return res.json({
                ok: true,
                message:
                    'Không có thay đổi.'
            });
        }

        if (
            !validateInventoryRevision(
                botState,
                requestedRevision
            )
        ) {
            return res.status(409).json({
                error:
                    'Inventory đã thay đổi. Đang đồng bộ lại...',
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    )
            });
        }

        if (
            botState.inventoryActionBusy
        ) {
            return res.status(409).json({
                error:
                    'Bot đang thực hiện thao tác inventory khác.'
            });
        }

        if (
            !canUseInventoryAction(botState)
        ) {
            return res.status(409).json({
                error:
                    'Bot chưa sẵn sàng thao tác inventory.'
            });
        }

        const bot =
            botState.bot;

        if (typeof bot.moveSlotItem !== 'function') {
            return res.status(501).json({
                error: 'Mineflayer hiện tại không hỗ trợ moveSlotItem.'
            });
        }

        const sourceItem =
            bot.inventory.slots[sourceSlot] ||
            null;

        if (!sourceItem) {
            return res.status(400).json({
                error:
                    'Ô nguồn đang trống.'
            });
        }

        const actionToken =
            beginInventoryAction(botState, bot);

        try {
            const beforeSource =
                itemSummary(sourceItem);

            const beforeDest =
                itemSummary(
                    bot.inventory.slots[destSlot] ||
                    null
                );

            addLog(
                botState,
                `[INV] Web move: ${getSlotLabel(sourceSlot)} → ${getSlotLabel(destSlot)} | ${beforeSource}.`
            );

            await withTimeout(
                bot.moveSlotItem(sourceSlot, destSlot),
                INVENTORY_ACTION_TIMEOUT_MS,
                'Di chuyển item',
                () => invalidateInventoryAction(botState)
            );

            if (!isInventoryActionCurrent(botState, bot, actionToken)) {
                return res.status(409).json({
                    error: 'Bot đã reconnect trong lúc thao tác inventory. Đang đồng bộ lại...',
                    revision: botState.inventoryRevision,
                    inventory: publicInventoryState(botState)
                });
            }

            await finishInventoryAction(
                botState,
                bot,
                actionToken
            );

            addLog(
                botState,
                `[INV] Web move hoàn tất: ${getSlotLabel(sourceSlot)} → ${getSlotLabel(destSlot)}.`
            );

            if (
                beforeDest !== 'empty'
            ) {
                addLog(
                    botState,
                    `[INV] Ô đích trước thao tác: ${beforeDest}.`
                );
            }

            res.json({
                ok: true,
                message:
                    'Đã di chuyển item.',
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    )
            });
        } catch (err) {
            addLog(
                botState,
                `[INV] Web move lỗi: ${err.message}`
            );

            res.status(500).json({
                error:
                    `Di chuyển thất bại: ${err.message}`,
                revision:
                    botState.inventoryRevision
            });
        } finally {
            endInventoryAction(botState, bot, actionToken);
        }
    }
);

app.post(
    '/api/inventory/equip',
    async (req, res) => {
        const sourceSlot =
            Number(req.body?.sourceSlot);

        const destination =
            typeof req.body?.destination === 'string'
                ? req.body.destination
                : '';

        const requestedRevision =
            Number(req.body?.revision);

        const validDestinations = [
            'head',
            'torso',
            'legs',
            'feet',
            'off-hand'
        ];

        if (
            !isValidPlayerInventorySlot(sourceSlot) ||
            !validDestinations.includes(destination)
        ) {
            return res.status(400).json({
                error:
                    'Nguồn hoặc vị trí trang bị không hợp lệ.'
            });
        }

        if (
            !validateInventoryRevision(
                botState,
                requestedRevision
            )
        ) {
            return res.status(409).json({
                error:
                    'Inventory đã thay đổi. Đang đồng bộ lại...',
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    )
            });
        }

        if (
            botState.inventoryActionBusy
        ) {
            return res.status(409).json({
                error:
                    'Bot đang thực hiện thao tác inventory khác.'
            });
        }

        if (
            !canUseInventoryAction(botState)
        ) {
            return res.status(409).json({
                error:
                    'Bot chưa sẵn sàng thao tác inventory.'
            });
        }

        const bot =
            botState.bot;

        if (typeof bot.equip !== 'function') {
            return res.status(501).json({
                error: 'Mineflayer hiện tại không hỗ trợ equip.'
            });
        }

        const item =
            bot.inventory.slots[sourceSlot] ||
            null;

        if (!item) {
            return res.status(400).json({
                error:
                    'Ô nguồn đang trống.'
            });
        }

        const actionToken =
            beginInventoryAction(botState, bot);

        try {
            addLog(
                botState,
                `[EQUIP] Web: ${itemSummary(item)} → ${destination}.`
            );

            await withTimeout(
                bot.equip(item, destination),
                INVENTORY_ACTION_TIMEOUT_MS,
                'Trang bị item',
                () => invalidateInventoryAction(botState)
            );

            if (!isInventoryActionCurrent(botState, bot, actionToken)) {
                return res.status(409).json({
                    error: 'Bot đã reconnect trong lúc thao tác inventory. Đang đồng bộ lại...',
                    revision: botState.inventoryRevision,
                    inventory: publicInventoryState(botState)
                });
            }

            await finishInventoryAction(
                botState,
                bot,
                actionToken
            );

            addLog(
                botState,
                `[EQUIP] Hoàn tất: ${itemSummary(item)} → ${destination}.`
            );

            res.json({
                ok: true,
                message:
                    'Đã trang bị item.',
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    )
            });
        } catch (err) {
            addLog(
                botState,
                `[EQUIP] Web lỗi: ${err.message}`
            );

            res.status(500).json({
                error:
                    `Trang bị thất bại: ${err.message}`,
                revision:
                    botState.inventoryRevision
            });
        } finally {
            endInventoryAction(botState, bot, actionToken);
        }
    }
);

app.post(
    '/api/inventory/unequip',
    async (req, res) => {
        const destination =
            typeof req.body?.destination === 'string'
                ? req.body.destination
                : '';

        const requestedRevision =
            Number(req.body?.revision);

        const validDestinations = [
            'head',
            'torso',
            'legs',
            'feet',
            'off-hand'
        ];

        if (
            !validDestinations.includes(
                destination
            )
        ) {
            return res.status(400).json({
                error:
                    'Vị trí unequip không hợp lệ.'
            });
        }

        if (
            !validateInventoryRevision(
                botState,
                requestedRevision
            )
        ) {
            return res.status(409).json({
                error:
                    'Inventory đã thay đổi. Đang đồng bộ lại...',
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    )
            });
        }

        if (
            botState.inventoryActionBusy
        ) {
            return res.status(409).json({
                error:
                    'Bot đang thực hiện thao tác inventory khác.'
            });
        }

        if (
            !canUseInventoryAction(
                botState
            )
        ) {
            return res.status(409).json({
                error:
                    'Bot chưa sẵn sàng thao tác inventory.'
            });
        }

        const bot =
            botState.bot;

        if (
            typeof bot.moveSlotItem !== 'function' &&
            typeof bot.unequip !== 'function'
        ) {
            return res.status(501).json({
                error: 'Mineflayer hiện tại không hỗ trợ tháo trang bị.'
            });
        }

        const destinationSlotMap = {
            head: 5,
            torso: 6,
            legs: 7,
            feet: 8,
            'off-hand':
                getOffhandSlot(bot)
        };

        const sourceSlot =
            destinationSlotMap[destination];

        const equippedItem =
            bot.inventory.slots[sourceSlot] ||
            null;

        if (!equippedItem) {
            return res.status(400).json({
                error:
                    'Vị trí trang bị đang trống.'
            });
        }

        let emptySlot = null;

        for (
            let slot = 9;
            slot <= 35;
            slot++
        ) {
            if (
                !bot.inventory.slots[slot]
            ) {
                emptySlot = slot;
                break;
            }
        }

        if (emptySlot === null) {
            return res.status(409).json({
                error:
                    'Inventory không còn ô trống để tháo trang bị.'
            });
        }

        const actionToken =
            beginInventoryAction(botState, bot);

        try {
            const summary =
                itemSummary(equippedItem);

            addLog(
                botState,
                `[EQUIP] Web tháo ${summary} từ ${destination}.`
            );

            let moved = false;

            if (
                typeof bot.moveSlotItem ===
                'function'
            ) {
                try {
                    await withTimeout(
                        bot.moveSlotItem(sourceSlot, emptySlot),
                        INVENTORY_ACTION_TIMEOUT_MS,
                        'Tháo trang bị',
                        () => invalidateInventoryAction(botState)
                    );

                    moved = true;
                } catch (_) {
                    moved = false;
                }
            }

            if (
                !moved &&
                typeof bot.unequip ===
                'function'
            ) {
                await withTimeout(
                    bot.unequip(destination),
                    INVENTORY_ACTION_TIMEOUT_MS,
                    'Tháo trang bị',
                    () => invalidateInventoryAction(botState)
                );
                moved = true;
            }

            if (!moved) {
                throw new Error('Không thể tháo trang bị với API Mineflayer hiện tại.');
            }

            if (!isInventoryActionCurrent(botState, bot, actionToken)) {
                return res.status(409).json({
                    error: 'Bot đã reconnect trong lúc thao tác inventory. Đang đồng bộ lại...',
                    revision: botState.inventoryRevision,
                    inventory: publicInventoryState(botState)
                });
            }

            await finishInventoryAction(
                botState,
                bot,
                actionToken
            );

            addLog(
                botState,
                `[EQUIP] Đã tháo ${summary} khỏi ${destination}.`
            );

            res.json({
                ok: true,
                message:
                    `Đã tháo trang bị ${destination}.`,
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    ),
                unequippedToSlot: emptySlot
            });
        } catch (err) {
            addLog(
                botState,
                `[EQUIP] Unequip lỗi: ${err.message}`
            );

            res.status(500).json({
                error:
                    `Tháo trang bị thất bại: ${err.message}`,
                revision:
                    botState.inventoryRevision
            });
        } finally {
            endInventoryAction(botState, bot, actionToken);
        }
    }
);

app.post(
    '/api/inventory/select',
    (req, res) => {
        const slot =
            Number(req.body?.slot);

        const requestedRevision =
            Number(req.body?.revision);

        if (
            !Number.isInteger(slot) ||
            slot < 0 ||
            slot > 8
        ) {
            return res.status(400).json({
                error:
                    'Hotbar slot phải từ 0 đến 8.'
            });
        }

        if (
            !validateInventoryRevision(
                botState,
                requestedRevision
            )
        ) {
            return res.status(409).json({
                error:
                    'Inventory đã thay đổi. Đang đồng bộ lại...',
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    )
            });
        }

        if (
            !canUseInventoryAction(botState)
        ) {
            return res.status(409).json({
                error:
                    'Bot chưa sẵn sàng.'
            });
        }

        if (
            !selectHotbarSlot(
                botState,
                slot
            )
        ) {
            return res.status(500).json({
                error:
                    'Không thể chọn hotbar slot.'
            });
        }

        scanInventory(
            botState,
            botState.bot,
            false
        );

        addLog(
            botState,
            `[HOTBAR] Web chọn slot ${slot + 1}.`
        );

        res.json({
            ok: true,
            message:
                `Đã chọn hotbar slot ${slot + 1}.`,
            revision:
                botState.inventoryRevision,
            inventory:
                publicInventoryState(
                    botState
                )
        });
    }
);

// -----------------------------------------------------------------------------
// Drop item outside inventory
// -----------------------------------------------------------------------------

app.post(
    '/api/inventory/drop',
    async (req, res) => {
        const sourceSlot =
            Number(req.body?.sourceSlot);

        const requestedRevision =
            Number(req.body?.revision);

        if (
            !isValidPlayerInventorySlot(
                sourceSlot
            )
        ) {
            return res.status(400).json({
                error:
                    'Slot vứt item không hợp lệ.'
            });
        }

        if (
            !validateInventoryRevision(
                botState,
                requestedRevision
            )
        ) {
            return res.status(409).json({
                error:
                    'Inventory đã thay đổi. Đang đồng bộ lại...',
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    )
            });
        }

        if (
            botState.inventoryActionBusy
        ) {
            return res.status(409).json({
                error:
                    'Bot đang thực hiện thao tác inventory khác.'
            });
        }

        if (
            !canUseInventoryAction(
                botState
            )
        ) {
            return res.status(409).json({
                error:
                    'Bot chưa sẵn sàng thao tác inventory.'
            });
        }

        const bot =
            botState.bot;

        const item =
            bot.inventory.slots[sourceSlot] ||
            null;

        if (!item) {
            return res.status(400).json({
                error:
                    'Ô nguồn đang trống.'
            });
        }

        if (
            typeof bot.tossStack !==
            'function'
        ) {
            return res.status(501).json({
                error:
                    'Mineflayer hiện tại không hỗ trợ tossStack.'
            });
        }

        const actionToken =
            beginInventoryAction(botState, bot);

        try {
            const summary =
                itemSummary(item);

            addLog(
                botState,
                `[DROP] Vứt ${summary} từ ${getSlotLabel(sourceSlot)}.`
            );

            await withTimeout(
                bot.tossStack(item),
                INVENTORY_ACTION_TIMEOUT_MS,
                'Vứt item',
                () => invalidateInventoryAction(botState)
            );

            if (!isInventoryActionCurrent(botState, bot, actionToken)) {
                return res.status(409).json({
                    error: 'Bot đã reconnect trong lúc thao tác inventory. Đang đồng bộ lại...',
                    revision: botState.inventoryRevision,
                    inventory: publicInventoryState(botState)
                });
            }

            await finishInventoryAction(
                botState,
                bot,
                actionToken
            );

            addLog(
                botState,
                `[DROP] Đã vứt ${summary}.`
            );

            res.json({
                ok: true,
                message:
                    `Đã vứt ${summary}.`,
                revision:
                    botState.inventoryRevision,
                inventory:
                    publicInventoryState(
                        botState
                    )
            });
        } catch (err) {
            addLog(
                botState,
                `[DROP] Lỗi vứt item: ${err.message}`
            );

            res.status(500).json({
                error:
                    `Vứt item thất bại: ${err.message}`,
                revision:
                    botState.inventoryRevision
            });
        } finally {
            endInventoryAction(botState, bot, actionToken);
        }
    }
);

// -----------------------------------------------------------------------------
// Health endpoint
// Render / Google Apps Script can call /health.
// -----------------------------------------------------------------------------


// -----------------------------------------------------------------------------
// Remote GUI Inspector API
// -----------------------------------------------------------------------------

app.post('/api/bot/window/click', async (req, res) => {
    const slot = Number(req.body?.slot);
    const mouseButton = Number(req.body?.mouseButton ?? 0);
    const mode = Number(req.body?.mode ?? 0);
    if (!botState.bot || !botState.bot.currentWindow) {
        return res.status(400).json({ ok: false, error: 'Không có cửa sổ GUI nào đang mở.' });
    }
    if (
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot >= botState.bot.currentWindow.slots.length
    ) {
        return res.status(400).json({ ok: false, error: 'Slot GUI không hợp lệ.' });
    }
    try {
        await Promise.resolve(botState.bot.clickWindow(slot, mouseButton, mode));
        addLog(botState, `[GUI] Click slot ${slot} (button ${mouseButton}).`);
        res.json({ ok: true, message: `Đã click slot ${slot}.` });
    } catch (err) {
        addLog(botState, `[GUI] Click slot ${slot} lỗi: ${err.message}`);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/bot/window/close', (req, res) => {
    const bot = botState.bot;
    if (!bot?.currentWindow) {
        return res.status(400).json({ ok: false, error: 'Không có cửa sổ GUI nào đang mở.' });
    }
    try {
        bot.closeWindow(bot.currentWindow);
        addLog(botState, '[GUI] Đã đóng cửa sổ GUI hiện tại.');
        return res.json({ ok: true, message: 'Đã đóng cửa sổ GUI.' });
    } catch (err) {
        addLog(botState, `[GUI] Đóng cửa sổ GUI lỗi: ${err.message}`);
        return res.status(500).json({ ok: false, error: err.message || 'Không thể đóng cửa sổ GUI.' });
    }
});

// -----------------------------------------------------------------------------
// Auth & Login Gate API for Bot Web UI
// -----------------------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
    const clientIp = getClientIp(req);
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password ?? '');

    const rateCheck = botLoginLimiter.check(clientIp, username || 'admin');
    if (!rateCheck.allowed) {
        return res.status(429).json({ ok: false, error: rateCheck.error });
    }

    if (!password) {
        return res.status(400).json({ ok: false, error: 'Vui lòng nhập mật khẩu.' });
    }

    // 1. Quản trị viên Admin
    if (!username || username.toLowerCase() === 'admin') {
        const adminHash = botState.syncedAuth?.adminPasswordHash;
        let isAdminCorrect = false;
        if (adminHash) {
            isAdminCorrect = verifyScryptPassword(password, adminHash);
        } else if (BOT_ADMIN_PASSWORD) {
            isAdminCorrect = timingSafeStringEquals(password, BOT_ADMIN_PASSWORD);
        } else {
            botLoginLimiter.record(clientIp, username || 'admin', false);
            return res.status(401).json({
                ok: false,
                error: 'Bot con chưa nhận được đồng bộ tài khoản từ Manager hoặc chưa cấu hình BOT_ADMIN_PASSWORD.'
            });
        }

        if (isAdminCorrect) {
            botLoginLimiter.record(clientIp, username || 'admin', true);
            const token = createBotSession('admin', 'admin', { allowAccountChange: true, passwordHash: adminHash || '' });
            res.setHeader('Set-Cookie', serializeBotCookie('bot_token', token, { maxAge: 86400, secure: isHttps(req) }));
            return res.json({ ok: true, role: 'admin', username: 'admin', allowAccountChange: true });
        }
        botLoginLimiter.record(clientIp, username || 'admin', false);
        return res.status(401).json({ ok: false, error: 'Mật khẩu Quản trị viên (Admin) không chính xác.' });
    }

    // 2. Khách thuê User: ưu tiên xác thực từ syncedAuth (bot_auth_cache.json)
    if (botState.syncedAuth) {
        const syncedUsers = Array.isArray(botState.syncedAuth.users) ? botState.syncedAuth.users : [];
        const u = syncedUsers.find(x => x.username.toLowerCase() === username.toLowerCase());
        if (!u) {
            botLoginLimiter.record(clientIp, username, false);
            return res.status(401).json({ ok: false, error: 'Tài khoản không tồn tại hoặc chưa được phân quyền cho bot này.' });
        }
        if (!verifyScryptPassword(password, u.passwordHash)) {
            botLoginLimiter.record(clientIp, username, false);
            return res.status(401).json({ ok: false, error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
        }
        if (u.status !== 'active') {
            botLoginLimiter.record(clientIp, username, false);
            return res.status(403).json({ ok: false, error: 'Tài khoản của bạn đã bị vô hiệu hóa hoặc chưa kích hoạt.' });
        }
        if (u.expiresAt && Date.now() > Date.parse(u.expiresAt)) {
            botLoginLimiter.record(clientIp, username, false);
            return res.status(403).json({ ok: false, error: 'Tài khoản của bạn đã hết hạn thuê. Vui lòng gia hạn trên Manager.' });
        }
        botLoginLimiter.record(clientIp, username, true);
        const token = createBotSession('user', u.username, { allowAccountChange: u.allowAccountChange !== false, passwordHash: u.passwordHash });
        res.setHeader('Set-Cookie', serializeBotCookie('bot_token', token, { maxAge: 86400, secure: isHttps(req) }));
        return res.json({
            ok: true,
            role: 'user',
            username: u.username,
            allowAccountChange: u.allowAccountChange !== false
        });
    }

    // 3. Fallback sang Manager nếu bot con chưa nhận được syncAuth lần nào
    if (MANAGER_API_URL && BOT_SECRET_KEY) {
        try {
            const targetManager = MANAGER_API_URL.replace(/\/+$/, '');
            const fetchRes = await fetch(targetManager + '/api/auth/verify-bot-access', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Bot-Secret': BOT_SECRET_KEY
                },
                body: JSON.stringify({
                    username,
                    password,
                    botId: BOT_ID_NUMBER
                }),
                signal: AbortSignal.timeout(5000)
            });
            const data = await fetchRes.json();
            if (data && data.ok) {
                botLoginLimiter.record(clientIp, username, true);
                const role = data.role === 'admin' ? 'admin' : 'user';
                const token = createBotSession(role, data.username || username, {
                    allowAccountChange: data.allowAccountChange !== false,
                    passwordHash: data.passwordHash || ''
                });
                res.setHeader('Set-Cookie', serializeBotCookie('bot_token', token, { maxAge: 86400, secure: isHttps(req) }));
                return res.json({
                    ok: true,
                    role,
                    username: data.username || username,
                    allowAccountChange: data.allowAccountChange !== false
                });
            } else {
                botLoginLimiter.record(clientIp, username, false);
                return res.status(fetchRes.status || 401).json({
                    ok: false,
                    error: data?.error || 'Tài khoản không có quyền truy cập bot này.'
                });
            }
        } catch (err) {
            return res.status(502).json({
                ok: false,
                error: 'Không thể kết nối tới Manager để xác thực khách thuê (' + err.message + ').'
            });
        }
    }

    botLoginLimiter.record(clientIp, username, false);
    return res.status(401).json({ ok: false, error: 'Chưa có dữ liệu đồng bộ auth từ Manager.' });
});

app.get('/api/auth/me', (req, res) => {
    const session = getBotSessionFromRequest(req);
    if (!session) {
        return res.json({ ok: false, loggedIn: false });
    }
    return res.json({
        ok: true,
        loggedIn: true,
        user: {
            role: session.role,
            username: session.username,
            allowAccountChange: session.allowAccountChange !== false
        }
    });
});

app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers['authorization'] || req.headers['x-bot-token'];
    let token = null;
    if (typeof authHeader === 'string') {
        token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    }
    if (!token && req.headers.cookie) {
        token = parseCookies(req).bot_token || null;
    }
    if (token && botSessions.has(token)) {
        botSessions.delete(token);
    }
    res.setHeader('Set-Cookie', clearBotCookieHeader('bot_token', isHttps(req)));
    res.json({ ok: true, message: 'Đã đăng xuất.' });
});

app.get(
    '/health',
    (req, res) => {
        const isOnline = botState.status !== 'offline';
        res.status(200).json({
            status: 'ok',
            service: 'kingmc-bot',
            online: isOnline ? 1 : 0,
            botStatus: botState.status || 'offline',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString()
        });
    }
);

// -----------------------------------------------------------------------------
// Dashboard root
// -----------------------------------------------------------------------------

const BOT_PUBLIC_LOGIN_HTML = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Đăng nhập • KBOT Worker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;850&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body { background: #060b16; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; color: #f8fafc; }
    .login-box { background: linear-gradient(145deg, #101a33 0%, #0a1122 100%); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 18px; width: 100%; max-width: 420px; padding: 32px 24px; box-shadow: 0 25px 60px rgba(0,0,0,0.8), 0 0 35px rgba(16, 185, 129, 0.15); text-align: center; }
    .icon { font-size: 40px; margin-bottom: 8px; filter: drop-shadow(0 0 12px rgba(56, 189, 248, 0.5)); }
    h2 { font-size: 21px; font-weight: 850; letter-spacing: -0.01em; margin-bottom: 4px; }
    p.sub { color: #94a3b8; font-size: 12.5px; line-height: 1.4; margin-bottom: 18px; }
    .discord-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; margin-bottom: 18px; padding: 11px 14px; background: linear-gradient(135deg, #5865F2 0%, #4752C4 100%); color: #fff; border-radius: 10px; text-decoration: none; font-size: 12.5px; font-weight: 800; box-shadow: 0 6px 18px rgba(88, 101, 242, 0.35); }
    .field { text-align: left; margin-bottom: 14px; }
    label { font-size: 11.5px; color: #cbd5e1; font-weight: 700; display: block; margin-bottom: 4px; letter-spacing: 0.3px; }
    input { width: 100%; background: #080e1c; border: 1px solid #1e293b; color: #fff; padding: 10px 12px; border-radius: 8px; font-size: 13.5px; outline: none; }
    input:focus { border-color: #38bdf8; box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2); }
    .pwd-wrap { position: relative; display: flex; align-items: center; }
    .toggle-pwd { position: absolute; right: 10px; background: none; border: none; cursor: pointer; color: #94a3b8; font-size: 14px; padding: 4px; }
    .btn-submit { width: 100%; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; padding: 12px; border-radius: 10px; font-size: 14.5px; font-weight: 800; cursor: pointer; letter-spacing: 0.4px; box-shadow: 0 4px 14px rgba(16,185,129,0.35); transition: all 0.2s; margin-top: 6px; }
    .btn-submit:hover { opacity: 0.95; transform: translateY(-1px); }
    .error-msg { display: none; color: #f87171; font-size: 12.5px; margin-bottom: 14px; padding: 9px 12px; background: rgba(239,68,68,0.12); border-radius: 8px; border: 1px solid rgba(239,68,68,0.35); text-align: left; }
    .note { font-size: 11px; color: #64748b; margin-top: 14px; line-height: 1.45; }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="icon">🛡️</div>
    <h2>KBOT WORKER V10.0</h2>
    <p class="sub">Cổng Điều Khiển Bot AFK KingMC • Cloud Engine</p>
    <a href="https://discord.gg/mJWX5Xp3z" target="_blank" rel="noopener noreferrer" class="discord-btn">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
      <span>Gia Nhập Discord Hỗ Trợ 24/7</span>
    </a>
    <div class="field">
      <label>TÀI KHOẢN (Bỏ trống nếu là Admin):</label>
      <input type="text" id="loginUsername" placeholder="Tài khoản khách thuê..." autocomplete="username">
    </div>
    <div class="field">
      <label>MẬT KHẨU TRUY CẬP:</label>
      <div class="pwd-wrap">
        <input type="password" id="loginPassword" placeholder="Mật khẩu Admin hoặc Manager..." autocomplete="current-password">
        <button type="button" class="toggle-pwd" onclick="togglePwd()">👁</button>
      </div>
    </div>
    <div id="loginErr" class="error-msg"></div>
    <button type="button" class="btn-submit" onclick="doLogin()">ĐĂNG NHẬP VÀO BOT</button>
    <div class="note">
      • Quản trị viên: Nhập mật khẩu Admin.<br>
      • Khách thuê: Nhập Username &amp; Mật khẩu được Manager phân quyền.
    </div>
  </div>
  <script>
    function togglePwd() {
      const p = document.getElementById('loginPassword');
      p.type = p.type === 'password' ? 'text' : 'password';
    }
    async function doLogin() {
      const u = document.getElementById('loginUsername').value.trim();
      const p = document.getElementById('loginPassword').value;
      const err = document.getElementById('loginErr');
      if (!p) {
        err.textContent = 'Vui lòng nhập mật khẩu.';
        err.style.display = 'block';
        return;
      }
      err.style.display = 'none';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (data && data.ok) {
          window.location.reload();
        } else {
          err.textContent = data.error || 'Đăng nhập không thành công.';
          err.style.display = 'block';
        }
      } catch (e) {
        err.textContent = 'Lỗi kết nối máy chủ: ' + e.message;
        err.style.display = 'block';
      }
    }
    document.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    window.togglePwd = togglePwd;
    window.doLogin = doLogin;
  </script>
</body>
</html>`;

app.get(
    '/',
    (req, res) => {
        const session = getBotSessionFromRequest(req);
        if (!session) {
            return res.type('html').send(BOT_PUBLIC_LOGIN_HTML);
        }

        const cur = publicSettingsState(botState, session.role === 'admin');
        const mem = process.memoryUsage();
        const rssMb = Math.round(mem.rss / (1024 * 1024));
        const heapMb = Math.round(mem.heapUsed / (1024 * 1024));
        let renderedHtml = HTML;
        if (cur.ecoMode) renderedHtml = renderedHtml.replace('id="settingEcoMode"', 'id="settingEcoMode" checked');
        if (cur.autoTotem) renderedHtml = renderedHtml.replace('id="settingAutoTotem"', 'id="settingAutoTotem" checked');
        if (cur.antiHungry) renderedHtml = renderedHtml.replace('id="settingAntiHungry"', 'id="settingAntiHungry" checked');
        if (cur.autoReconnect) renderedHtml = renderedHtml.replace('id="settingAutoReconnect"', 'id="settingAutoReconnect" checked');
        if (cur.antiAfkKick) renderedHtml = renderedHtml.replace('id="settingAntiAfkKick"', 'id="settingAntiAfkKick" checked');

        // Pre-render RAM ngay từ lúc tải trang HTML (kể cả khi bot chưa bấm Chạy)
        renderedHtml = renderedHtml.replace('id="topRamUsage">-- MB', `id="topRamUsage">${rssMb} MB`);
        renderedHtml = renderedHtml.replace('id="detailRamUsage" class="info-value" style="color:var(--green);">-- MB', `id="detailRamUsage" class="info-value" style="color:var(--green);">${rssMb} MB (Heap ${heapMb} MB)`);

        res
            .type('html')
            .send(renderedHtml);
    }
);

// -----------------------------------------------------------------------------
// Cloud Host Healthcheck & Lightweight Status Endpoints
// -----------------------------------------------------------------------------

app.get(
    ['/healthz', '/api/health'],
    (req, res) => {
        const mem = process.memoryUsage();
        res.json({
            status: 'ok',
            service: 'bot',
            botId: BOT_ID,
            botStatus: botState.status,
            ready: botState.ready,
            uptime: Math.round(process.uptime()),
            serverTps: Number.isFinite(botState.serverTps) ? botState.serverTps : (['afk', 'online', 'entering', 'authenticating'].includes(botState.status) ? 20.0 : 0.0),
            memory: {
                rssMb: Math.round(mem.rss / (1024 * 1024)),
                heapMb: Math.round(mem.heapUsed / (1024 * 1024))
            },
            timestamp: new Date().toISOString()
        });
    }
);

app.get(
    '/api/status',
    (req, res) => {
        res.json({
            status: botState.status,
            ready: botState.ready,
            ping: getPing(botState),
            connectedAt: botState.connectedAt,
            botId: BOT_ID
        });
    }
);

// Express Catch-All Error Handler (Mounted after all route handlers)
app.use((err, req, res, next) => {
    console.error(`[UNHANDLED_ERROR] ${req.method} ${req.originalUrl || req.url}:`, err.stack || err.message || err);
    if (res.headersSent) {
        return next(err);
    }
    return res.status(500).json({ ok: false, error: 'Đã xảy ra lỗi máy chủ nội bộ.' });
});

// -----------------------------------------------------------------------------
// HTTP server
// -----------------------------------------------------------------------------

function scheduleAutoStartOnBoot() {
    const hasConfiguredCredentials =
        !!(botState.username && botState.password);

    if (!hasConfiguredCredentials) {
        addLog(
            botState,
            'Bot đang OFFLINE: Chưa có username/password. Có thể nhập tài khoản trên web rồi bấm Chạy.'
        );
        return;
    }

    if (!AUTO_START_ON_BOOT) {
        addLog(
            botState,
            'AUTO_START đang tắt trong BOT_CONFIG. Bot đang OFFLINE.'
        );
        return;
    }

    if (botState.manuallyStopped) {
        addLog(
            botState,
            'Bot đang ở trạng thái DỪNG THỦ CÔNG (manuallyStopped). Bot đang OFFLINE, chờ người dùng khởi động.'
        );
        return;
    }

    addLog(
        botState,
        `Đã đọc credential từ tài khoản (${botState.username}). Service đã listen, đang tự khởi động bot.`
    );

    clearAfkTimers(botState);

    const bootTimer = setTimeout(() => {
        if (botState.shuttingDown) {
            return;
        }

        if (botState.bot) {
            return;
        }

        const started = startBot(botState, 'boot');

        addLog(
            botState,
            started
                ? 'Auto-start sau khi service khởi động: đã bắt đầu kết nối.'
                : 'Auto-start không thành công: kiểm tra credential và trạng thái service.'
        );
    }, 250);

    botState.afkTimers.push(bootTimer);
}

let server = null;
listenHttpServer(app, HTTP_PORT, PLATFORM, (serverInstance, activePort) => {
    server = serverInstance;
    HTTP_PORT = activePort;
    console.log('================================================================================');
    console.log(`  🚀 KINGMC AFK BOT WORKER (PRO V7) ĐÃ KHỞI CHẠY THÀNH CÔNG!`);
    console.log(`  🌐 WEB DASHBOARD: http://localhost:${activePort} (hoặc domain VPS / Hosting)`);
    console.log(`  📦 NỀN TẢNG: ${PLATFORM.toUpperCase()} | PORT WEB: ${activePort}`);
    console.log(`  🎮 SERVER MINECRAFT: ${HOSTS.join(', ')}:${PORT} | PHIÊN BẢN: ${MC_VERSION}`);
    const creds = { username: botState.username, password: botState.password };
    if (!creds.username || !creds.password) {
        console.log(`  ⚠️  CHÚ Ý: Chưa cấu hình USERNAME / PASSWORD. Bot đang đợi nhập từ Web UI!`);
    } else {
        console.log(`  👤 TÀI KHOẢN: ${creds.username} (Tự động kết nối)`);
    }
    console.log('================================================================================');
    startPublicIpMonitor(botState);
    void (async () => {
        // Cloud state is the source of truth on a fresh host. Do not connect
        // with stale local credentials before its restore has completed.
        await initBotSupabaseSync();
        scheduleAutoStartOnBoot();
    })();
});

async function initBotSupabaseSync() {
    if (!botSupabase || !botSupabase.isEnabled()) {
        console.log('[BOT SUPABASE] Chưa cấu hình Supabase Cloud. Bot sử dụng lưu trữ cấu hình cục bộ.');
        return;
    }
    try {
        botSupabase.botId = String(botState.botId || BOT_ID || '1');
        console.log(`[BOT SUPABASE] ☁️ Đang kiểm tra cấu hình bot #${botSupabase.botId} trên Supabase Cloud...`);
        const remote = await botSupabase.fetchBotSettings();
        if (remote && typeof remote === 'object') {
            console.log(`[BOT SUPABASE] ✅ Đã tìm thấy cấu hình trên Supabase! Khôi phục vào botState...`);
            if (typeof remote.username === 'string') {
                botState.username = remote.username.trim();
            }
            if (typeof remote.password === 'string') {
                const cloudPassword = remote.password ? decryptMinecraftPassword(remote.password) : '';
                botState.password = cloudPassword || remote.password || '';
                botState.rawEncryptedPassword = null;
            }
            if (remote.settings && typeof remote.settings === 'object') {
                const { manuallyStopped: cloudManuallyStopped, proxy: settingsProxy, ...cloudSettings } = remote.settings;
                botState.settings = { ...botState.settings, ...cloudSettings };
                if (typeof cloudManuallyStopped === 'boolean') {
                    botState.manuallyStopped = cloudManuallyStopped;
                }
                const cloudProxy = remote.proxy && typeof remote.proxy === 'object'
                    ? remote.proxy
                    : settingsProxy;
                if (cloudProxy && typeof cloudProxy === 'object') {
                    const encryptedProxyPassword = String(cloudProxy.password || '');
                    const proxyPassword = encryptedProxyPassword
                        ? decryptMinecraftPassword(encryptedProxyPassword)
                        : '';
                    botState.settings.proxy = {
                        ...botState.settings.proxy,
                        ...cloudProxy,
                        password: proxyPassword || encryptedProxyPassword || ''
                    };
                }
            } else if (remote.proxy && typeof remote.proxy === 'object') {
                const encryptedProxyPassword = String(remote.proxy.password || '');
                const proxyPassword = encryptedProxyPassword
                    ? decryptMinecraftPassword(encryptedProxyPassword)
                    : '';
                botState.settings.proxy = { ...botState.settings.proxy, ...remote.proxy, password: proxyPassword || encryptedProxyPassword || '' };
            }
            if (Array.isArray(remote.schedules)) {
                botState.botSchedules = sanitizeBotSchedules(remote.schedules);
            }
            if (Array.isArray(remote.auto_chat)) {
                botState.autoChatSchedules = sanitizeAutoChatSchedules(remote.auto_chat);
            }
            saveBotSettingsFile(botState.settings, botState.autoChatSchedules, botState.botSchedules, {
                username: botState.username,
                password: botState.password,
                manuallyStopped: botState.manuallyStopped
            });
        } else {
            console.log(`[BOT SUPABASE] ℹ️ Chưa có bản ghi bot #${botSupabase.botId} trên Supabase. Đẩy cấu hình hiện tại lên Cloud...`);
            const payload = {
                username: botState.username,
                password: botState.password ? encryptMinecraftPassword(botState.password) : '',
                settings: botState.settings,
                proxy: botState.settings?.proxy || {},
                botSchedules: botState.botSchedules,
                autoChatSchedules: botState.autoChatSchedules,
                manuallyStopped: botState.manuallyStopped
            };
            await botSupabase.saveBotSettings(payload);
        }
    } catch (err) {
        console.error('[BOT SUPABASE] ❌ Lỗi đồng bộ ban đầu:', err.message);
    }
}


// -----------------------------------------------------------------------------
// Graceful process shutdown
// -----------------------------------------------------------------------------

function shutdownProcess(signal) {
    if (botState.shuttingDown) {
        return;
    }

    botState.shuttingDown = true;

    console.log(
        `[PROCESS] Nhận ${signal}, đang shutdown...`
    );

    botState.manuallyStopped = true;

    clearAllTimers(
        botState,
        true
    );
    clearBotSchedulerTimer(botState);

    if (botState.bot) {
        const currentBot = botState.bot;
        botState.bot = null;

        try {
            if (typeof currentBot.quit === 'function') {
                currentBot.quit(`Process ${signal}`);
            }
        } catch (err) {
            console.log(
                `[PROCESS] Shutdown bot error: ${err.message}`
            );
        } finally {
            cleanupBotResources(currentBot);
        }
    }

    if (server) {
        server.close(() => {
            console.log(
                '[PROCESS] HTTP server closed.'
            );

            process.exit(0);
        });

        setTimeout(() => {
            process.exit(0);
        }, 5000);
    } else {
        process.exit(0);
    }
}

process.on(
    'SIGTERM',
    () => shutdownProcess('SIGTERM')
);

process.on(
    'SIGINT',
    () => shutdownProcess('SIGINT')
);

process.on('uncaughtException', (err) => {
    console.error('[PROCESS] Uncaught Exception:', err.message || err);
    try {
        addLog(botState, `⚠️ [LỖI HỆ THỐNG] ${err.message || 'Lỗi không xác định'}`);
    } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
    console.error('[PROCESS] Unhandled Rejection:', reason?.message || reason);
    try {
        addLog(botState, `⚠️ [LỖI ASYNC] ${reason?.message || 'Promise rejection'}`);
    } catch (_) {}
});

// -----------------------------------------------------------------------------
// FINAL STARTUP STATE
//
// - BOT_CONFIG có username/password => tự khởi động sau khi HTTP service listen.
// - BOT_CONFIG thiếu credential => giữ OFFLINE để chờ nhập từ web.
// - AUTO_START=false => tắt auto-start nhưng vẫn giữ nút Chạy thủ công.
// -----------------------------------------------------------------------------

botState.manuallyStopped = (typeof botState.manuallyStopped === 'boolean') ? botState.manuallyStopped : true;
botState.ready = false;
setBotStatus(botState, 'offline');
botState.connectedAt = null;
resetInventoryState(botState);

// Auto-start được gọi sau khi HTTP server listen xong để bot chỉ kết nối
// sau khi dashboard/web service đã sẵn sàng.


// ============================================================================
// END OF FILE
// ============================================================================
//
// File này là bản 1-bot hardcoded hoàn chỉnh.
//
// Chức năng giữ lại:
// - Mineflayer
// - Express dashboard
// - Login /dn
// - Fallback /register
// - Fallback /login
// - Lobby detection
// - /menu
// - Click slot 24
// - AFK state
// - Start / Stop / Restart
// - Reconnect + host fallback
// - Chat / command
// - Runtime username/password
// - Credential API cho Manager: /api/bot/credentials
// - Health endpoint
// - Lightweight status endpoint
// - Auto-start từ credential hardcode trong BOT_CONFIG sau khi HTTP listen
// - UTC+7 log time
// - Log filtering
// - Log scroll position preservation
// - View distance tuning
// - Graceful shutdown
// - BOT_ID hardcode trong BOT_CONFIG
// - CORS/API discovery cho central dashboard
//
// Lưu ý:
// Phần này chỉ là marker kết thúc file.
// Không cần thêm code khác sau đây.
// ============================================================================

