# Configuration Reference

This page is the single source for every setting. Other documents link here instead of repeating tables.

## Requirements

* **Node.js 24 LTS or newer.** The server runs TypeScript sources directly using Node's built-in type stripping (`node server/src/main.ts`).

## Mode Selection

The same entry point runs either node type:

* **Edge mode** when `HUB_URL` (or `--hub-url`) is set.
* **Hub mode** otherwise.

There are no aliases for `HUB_URL`.

## Precedence

CLI flag > environment variable > default. Durations are in seconds unless the name ends in `_MS`.

## Common Settings (Hub and Edge)

| CLI Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `-w`, `--workers <n>` | `WORKERS` | `1` | Worker processes. See [valid combinations](#valid-dependency-combinations) for the Hub. |
| `--heartbeat-interval <s>` | `HEARTBEAT_INTERVAL` | `10` | Seconds between pings on every WebSocket connection (lifelines, runtime sockets, relayed sockets). Keeps connections alive across NATs, proxies and load balancers. See [Heartbeat](../1-concepts/protocol-spec.md#3-heartbeat-all-websocket-connections). |
| `--heartbeat-timeout <s>` | `HEARTBEAT_TIMEOUT` | `30` | Seconds without receiving anything from a peer before the connection is closed with `heartbeat_timeout`. |
| `--hook-timeout <s>` | `HOOK_TIMEOUT` | `5` | Maximum time an awaited hook may run. A gating hook that exceeds it is treated as having thrown (fail-closed). See [Hooks](../4-extensibility/hooks.md#execution-model). |
| `--shutdown-timeout <s>` | `SHUTDOWN_TIMEOUT` | `30` | On `SIGINT` / `SIGTERM`, maximum time to let active sessions finish before they are closed with `hub_shutdown` / `edge_shutdown`. |
| `--plugin <paths>` | `PLUGINS` | *none* | Comma-separated plugin module paths, resolved from the working directory. Loaded in the Primary and in every worker. See [Loading Plugins](../4-extensibility/hooks.md#loading-plugins). |
| `--log-level <level>` | `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `--log-format <format>` | `LOG_FORMAT` | `text` | `text` or `json` (one JSON object per line). |
| `-q`, `--quiet` | `QUIET` | `false` | Shorthand for `LOG_LEVEL=warn`. |

## Hub Settings

| CLI Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `-p`, `--port <n>` | `PORT` | `3000` | Listening TCP port for HTTP (REST API) and WebSocket upgrades. |
| `--host <address>` | `HOST` | `0.0.0.0` | Bind address. |
| `--postgres-url <url>` | `POSTGRES_URL` | *none* | Use PostgreSQL storage. Required when `WORKERS > 1` (unless `ALLOW_FILESYSTEM_MULTIWORKER`). |
| `--redis-url <url>` | `REDIS_URL` | *none* | Use the Redis KV provider. Required when `WORKERS > 1` (unless `ALLOW_FILESYSTEM_MULTIWORKER`). |
| `-d`, `--data-dir <path>` | `DATA_DIR` | `data` | Directory for filesystem storage (`store.json`) and, in test mode, the shared file KV (`kv.json`). |
| `--allow-fs-multiworker` | `ALLOW_FILESYSTEM_MULTIWORKER` | `false` | **Tests only.** Allows `WORKERS > 1` without PostgreSQL and/or Redis by substituting file-backed providers shared through `DATA_DIR`. See [Test Mode](#test-mode-multi-worker-without-postgresql-or-redis). |
| `--connect-timeout <s>` | `CONNECT_TIMEOUT` | `10` | The single connection-establishment budget. See [Connection Establishment Budget](../1-concepts/protocol-spec.md#connection-establishment-budget). |
| `--trusted-proxies <cidrs>` | `TRUSTED_PROXIES` | *none* | Comma-separated CIDRs of reverse proxies whose `X-Forwarded-For` is trusted when computing `req.clientIp`. See [Client IP](../3-subsystems/http-server.md#client-ip-resolution). |
| `--entity-cache-ttl <s>` | `ENTITY_CACHE_TTL` | `60` | TTL of cached tunnel/edge records resolved by token. |
| `--negative-cache-ttl <s>` | `NEGATIVE_CACHE_TTL` | `5` | TTL of cached "token not found" results. |
| `--max-pending-orders <n>` | `MAX_PENDING_ORDERS` | `1000` | Pending orders allowed per Edge lifeline before new requests fail with `edge_saturated`. |
| `--max-lifeline-buffer <bytes>` | `MAX_LIFELINE_BUFFER` | `1048576` | Outgoing buffered bytes allowed on a lifeline before new requests fail with `edge_saturated`. |

## Edge Settings

| CLI Flag | Environment Variable | Default | Description |
| :--- | :--- | :--- | :--- |
| `--hub-url <url>` | `HUB_URL` | *required* | WebSocket URL of the Hub, e.g. `wss://tunnels.example.com` (behind a TLS proxy) or `ws://localhost:3000` (local). |
| `--token <token>` | `TOKEN` | *one of token/token-file required* | Edge token (`edg_...`). Statically configured; in revoked state, 300s poll acts as a quiescent keep-alive to prevent container restart thrashing. |
| `--token-file <path>` | `TOKEN_FILE` | *none* | Path to file containing Edge token. Re-read on startup and before each poll in the revoked state, enabling automatic recovery when rotated via Kubernetes/Docker secrets. |
| `--reconnect-interval <s>` | `RECONNECT_INTERVAL` | `1` | Initial lifeline reconnect backoff. |
| `--max-reconnect-interval <s>` | `MAX_RECONNECT_INTERVAL` | `30` | Maximum lifeline reconnect backoff. |
| `--drain-timeout <s>` | `DRAIN_TIMEOUT` | `30` | In the revoked state, maximum time to let in-flight sessions finish before force-closing them. |
| `--revoked-poll-interval <s>` | `REVOKED_POLL_INTERVAL` | `300` | Interval between lifeline attempts while in the revoked state. |

The Edge has no connect timeout of its own; it uses the `connectTimeoutMs` sent in each order.

## Valid Dependency Combinations

The Hub validates its configuration at startup and exits with a usage error on any invalid combination.

| `WORKERS` | Storage | KV | Valid |
| :--- | :--- | :--- | :--- |
| `1` | Filesystem (default) | Memory (default) | Yes (default profile) |
| `1` | PostgreSQL | Memory | Yes |
| `1` | Filesystem | Redis | Yes |
| `1` | PostgreSQL | Redis | Yes |
| `> 1` | PostgreSQL | Redis | Yes (clustered profile) |
| `> 1` | Filesystem (shared) and/or File KV | | Only with `ALLOW_FILESYSTEM_MULTIWORKER` (test mode) |
| `> 1` | anything else | anything else | **No**: startup error |

Clustering scales across the cores of **one host**. Running several Hub hosts against the same PostgreSQL and Redis is not supported: worker identities and socket migration are host-local.

The Edge has no storage or KV dependencies in any mode.

## Test Mode: Multi-Worker Without PostgreSQL or Redis

`ALLOW_FILESYSTEM_MULTIWORKER=true` (or `--allow-fs-multiworker`) exists so that every clustered behavior (IPC through the Primary, socket migration, presence, tickets, revocation broadcasts) can be exercised in fast unit and integration tests without starting and tearing down PostgreSQL and Redis.

* **Effect**: only applies when `WORKERS > 1`. Whichever dependency is not configured is replaced by a file-backed provider shared by all processes through `DATA_DIR`: the [filesystem storage provider in shared mode](../3-subsystems/storage-layer.md#shared-mode-test-only) instead of PostgreSQL, and the [`FileKVProvider`](../3-subsystems/key-value-store.md#filekvprovider-test-only) instead of Redis. A configured `POSTGRES_URL` or `REDIS_URL` is still used. Behavior is otherwise identical to the clustered profile.
* **No effect** when `WORKERS = 1`, or when both `POSTGRES_URL` and `REDIS_URL` are set; the Hub logs an `info` line saying the flag is ignored.
* **Warning**: every start with the flag active logs a `warn` entry: `ALLOW_FILESYSTEM_MULTIWORKER is enabled: file-backed shared storage/KV is for tests only (slow, global file lock, not durable).` When `NODE_ENV=production`, the same message is logged at `error` level. The Hub still starts; the flag is never enabled implicitly. This is the only place `NODE_ENV` is read, and it changes only the log level of this message, never behavior.
* **Not for production**: every storage and KV operation takes a cross-process file lock and hits the disk, so throughput is low, and the data lives on one local disk.
* **Isolation**: give each test run its own `DATA_DIR` (e.g. a temporary directory) so runs cannot share state.

## Deployment Requirement: TLS

The Hub always speaks plain HTTP/WebSocket. For any deployment reachable beyond `localhost`, place a TLS-terminating reverse proxy or load balancer (Caddy, nginx, Traefik, a cloud load balancer) in front of it and:

1. Forward WebSocket upgrades (`Upgrade` / `Connection` headers) to the Hub.
2. Set `TRUSTED_PROXIES` to the proxy's address range so client IPs are resolved from `X-Forwarded-For`.
3. Give the proxy an idle timeout longer than `HEARTBEAT_INTERVAL` (the default of 10s is shorter than the idle timeout of common proxies).

Edges then use `HUB_URL=wss://...`. Tokens travel in the `Authorization` header and must not cross an unencrypted network.
