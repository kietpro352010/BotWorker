# Worker feature map

## Runtime and capacity

- One Node process hosts one or two independent Minecraft bot slots, each with its own worker ID, secret, account, session and reconnect lifecycle.
- Slots share one HTTP server, event loop, resource sampler and shutdown path. Start spacing is eight seconds to limit connection and memory spikes.
- Mineflayer view distance defaults to `short`; V8 heap is capped at 384 MB and host RSS warnings default to 440 MB.

## AFK and connection lifecycle

- AFK defaults to `still`; optional `look` and `sneak` modes.
- Username/password arrive from Discord Manager over worker-authenticated HTTPS bootstrap and are not logged or placed in worker environment variables.
- A one-time optional `JOIN_COMMAND` can enter a configured lobby after spawn. No repeated auto-chat, menu click, inventory, container, GUI or hotbar interaction is used.
- Daily maintenance is fixed to 04:30 stop and 05:30 resume in `Asia/Ho_Chi_Minh` (Vietnam time, UTC+7); reconnect attempts are suppressed during that interval.
- Ordinary reconnects use bounded exponential backoff/jitter. Ban/IP-limit is held for explicit review and does not trigger account/proxy/host rotation.
- Optional static SOCKS5 proxy; its credentials do not appear in status or logs.

## Manager-facing operations and metrics

- Authenticated actions: start, stop, restart, resume, status, chat, reset, AFK mode and proxy.
- Minecraft `/login`, `/register` and password-change commands are blocked from remote chat.
- Status includes a local TPS estimate from worker physics ticks, ping, uptime, reconnect counters, maintenance state, process CPU/RAM and actual bytes per second on Minecraft sockets.
- CPU/RAM reflect the shared Node process when two slots run on the same host. Network byte rates are per Minecraft session socket.
- Event/chat stream is retained in Supabase by the manager; the Discord detail panel displays only its five newest rows at the time of refresh.
- Selected parsed Mineflayer events/plugins are suppressed to reduce processing. The filter does not discard raw protocol bytes needed by Minecraft connection; no claim of raw bandwidth reduction.

## Manager transport

- Render uses `/api/v1/bots/:workerId/{status,command}` with that slot's `x-worker-secret`.
- Wispbyte uses per-slot `/api/v1/workers/:workerId/{bootstrap,heartbeat,events,poll,result}` calls with an outbound long poll.
- Supabase credentials never exist on worker hosts; worker IDs and secrets stay independent for each slot.
