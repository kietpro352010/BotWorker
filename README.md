# KingMC AFK Worker

One worker process can run up to two independent Minecraft bot slots on the same Render or Wispbyte host. Each slot keeps its own manager ID, secret, account, connection state, reconnect counter, and command queue. The host shares one Node process, HTTP server, and resource monitor.

The normal AFK mode is `still`: after account login and optional lobby entry, it sends no movement input. Authorized users can send a chat message from the Discord panel. GUI, inventory, container and hotbar control, repeated auto-chat and configurable schedules are not part of this worker.

## Project layout

```text
src/
  config/       environment validation and SOCKS5 parsing
  domain/       normalized worker states
  game/         Mineflayer session, AFK, login, lobby navigation, status
  http/         health and per-worker-secret control endpoints
  services/     two-slot worker fleet and serialized command runtime
  transports/   manager heartbeat and Wispbyte long-poll transport
  utils/        redacted structured logs
```

## Configure one or two bots

1. Install Node.js 20 or newer.
2. Configure environment variables in `.env` (refer to the Settings table below) and set `MANAGER_URL`.
3. In the Discord manager, register each slot separately. Copy each one-time secret to the matching `WORKER_SECRET_1` or `WORKER_SECRET_2` variable.
4. Set a different `WORKER_ID` and worker secret for each slot. Enter the Minecraft username/password from the private Discord panel; do not put them in worker environment variables.
5. Run `npm ci` and `npm start`.

When `WORKER_ID_2` is set, the worker automatically starts two slots; otherwise it starts one. `WORKER_BOT_COUNT` is only an optional override. Minecraft account credentials are manager-managed and arrive through the authenticated HTTPS bootstrap before connect/reconnect commands.

Each slot uses its own `/api/v1/workers/:workerId` identity at the manager. A Render host has one public service URL shared by both slots; manager control uses `/api/v1/bots/:workerId/status` and `/api/v1/bots/:workerId/command`. Wispbyte slots each make their own authenticated outbound poll. Worker IDs and secrets must be registered separately in the manager.

## Settings

| Variable | Purpose |
|---|---|
| `WORKER_BOT_COUNT` | One or two accounts in this host process. |
| `WORKER_TRANSPORT` | Optional override. Normally auto-detected: Render uses direct authenticated HTTP; Wispbyte uses outbound polling. |
| `WORKER_ID_1`, `WORKER_SECRET_1` | Identity and secret for slot 1. Slot 2 uses the `_2` suffix. Minecraft credentials are set in Discord Manager. |
| `MANAGER_URL` | HTTPS URL of the manager service. |
| `MC_AUTH_TYPE` | Mineflayer account mode: `offline` or `microsoft`. Each slot may override it. |
| `MC_AUTH_ENABLED` | Replies to KingMC registration/login prompts using the password saved for that worker in Discord Manager. |
| `MC_SERVER_HOSTS`, `MC_SERVER_PORT`, `MC_SERVER_VERSION` | Approved KingMC endpoint and protocol version. Host fallback is used only for ordinary connection failures. |
| `MC_VIEW_DISTANCE` | Defaults to `short` to reduce loaded chunks and memory for an AFK worker. Set per slot with `MC_VIEW_DISTANCE_1` or `_2`. |
| `MC_PROXY_URL_1`, `MC_PROXY_URL_2` | Optional fixed SOCKS5 connection for that slot, e.g. `socks5://user:password@host:1080`. Do not place credentials in source control. |
| `AFK_MODE` | `still` by default; optional `look` or `sneak`. Per-slot overrides are supported. |
| `JOIN_COMMAND` | Optional one-time lobby entry command sent after spawn. Account registration/password commands are blocked. No menu click or repeated auto-chat is run. |
| `AUTO_START`, `AUTO_RECONNECT`, `RECONNECT_BASE_MS`, `RECONNECT_MAX_MS` | Startup and bounded retry settings. The two slots start eight seconds apart to smooth connection and memory spikes. |
| `CONNECT_TIMEOUT_MS` | Maximum duration for a connection attempt. |
| `WORKER_RSS_WARN_MB` | Log a warning when host RSS reaches this threshold; it does not stop a bot. |

`MC_AUTH_ENABLED` is for KingMC's in-game `/login` prompt. It is separate from `MC_AUTH_TYPE`, which selects the Minecraft account authentication mode. The manager encrypts account credentials in Supabase; the worker receives them only through the per-worker authenticated HTTPS bootstrap. Credentials are not included in status, events, command queue, or structured logs.

## Manager controls and status

The authenticated worker API accepts `start`, `stop`, `restart`, `resume`, `status`, `reset`, `set-afk-mode`, `set-proxy`, and `chat`. Every slot is authenticated with its own high-entropy `WORKER_SECRET`.

Status reports state, AFK mode, ping when available, manager request latency, uptime, reconnect counts, a local TPS estimate from worker physics ticks, process CPU/RAM, measured Minecraft socket bytes per second, restriction state, and proxy enabled/disabled. CPU/RAM are shared process values when two slots share a host. Discord panel/status omits host and Minecraft IP/hostname. Public `/health` reveals only bot count and process resource totals; per-bot state requires the matching worker secret.

The manager receives connection events and public chat messages in the same event stream; Discord shows the five newest lines only when the panel is opened or refreshed by an action. Remote Minecraft `/login`, `/register`, and password-change commands are blocked. Chat payload size and command rates are bounded and serialized.

The old event filter is adapted at the parsed Mineflayer event/plugin layer: selected particles, sounds, light/entity effects and optional plugins are ignored to lower local processing and world memory. Minecraft protocol packets still need to arrive and required keepalive/player/chat traffic must remain enabled; this does not save the bytes already received from the server.

At 04:30 every day in `Asia/Ho_Chi_Minh` (Vietnam time, UTC+7), an active bot stops; automatic reconnect remains disabled through the window. It resumes at 05:30 if it had been started and was not manually stopped or held by a server restriction. The window is fixed in code and cannot be edited from Discord.

## Hosting

### Render

Use this repository as the Render Web Service root. Set both worker identities and secrets plus the manager URL. Minecraft usernames/passwords are entered in the Discord manager, not in Render environment variables. The service exposes `/health`; manager control requests use the per-slot endpoint and secret. Use an always-on plan for continuous AFK. The free Render service spins down and cannot keep a Minecraft connection alive; see [Render's free instance limits](https://render.com/docs/free).

### Wispbyte

Upload this project as one Node process and configure both slots. The worker recognizes Render markers or Wispbyte/Pterodactyl environment markers and selects the matching transport; port is read from `SERVER_PORT`, `P_SERVER_PORT`, `ALLOCATION_PORT` or `PORT`. Each Wispbyte bot slot opens its own authenticated long poll to the manager, so the manager does not need inbound access to Wispbyte. Render and Wispbyte workers can be registered and managed at the same time. The Discord token and Supabase secret belong only on the manager.

## Runtime safeguards

- AFK is idle by default; `still` never sends movement input.
- A ban or IP limit stops the session and requires an explicit manager resume after review. Proxy settings never rotate automatically and cannot be changed during a restriction hold.
- Reconnect backoff is bounded and jittered. Alternate approved hosts are used only for ordinary connection failures.
- Shutdown stops both pollers and sessions cleanly. The worker process reserves a 384 MB V8 heap ceiling and warns before host RSS approaches the default 440 MB threshold.
- Worker health and controls expose no passwords, proxy credentials, or manager secrets.
