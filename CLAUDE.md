# Worker project notes

## Stack and entry point
- Node.js 20+, CommonJS, Mineflayer, Express, SOCKS5 support.
- Runtime starts at `src/index.js`; config is read from environment variables in `src/config/env.js`.
- One process supports one or two independent KingMC sessions. The default AFK mode is `still`.

## Structure and conventions
- `src/game/` owns Minecraft lifecycle and game actions; `src/services/` composes sessions and validates serialized manager actions.
- `src/transports/` contains manager HTTP reporting and Wispbyte outbound polling; `src/http/` exposes Render controls and health.
- Keep worker actions synchronized with `D:\manager\src\services\worker-registry.js` and the allowed action list in `D:\manager\supabase\migrations\20261108000000_durable_worker_commands.sql`.
- Do not add Supabase credentials or direct Supabase access to this worker.
- Minecraft usernames and passwords are managed by Discord Manager and delivered only through the authenticated HTTPS bootstrap; never put them in host environment variables or logs.

## Common commands
- Install: `npm ci`
- Run: `npm start`
- Render transport: `npm run start:render`
- Wispbyte transport: `npm run start:wispbyte`
- Deploy blueprint: `render.yaml`

## Configuration and operations
- Use `.env.example` as the variable reference and `README.md` / `FEATURES.md` for host behavior.
- Worker IDs and secrets are provisioned through the Discord manager; use one separate ID/secret/account per slot.
- A Minecraft ban or IP limit must remain a restriction hold requiring manager review; do not add automatic evasion or credential rotation.
