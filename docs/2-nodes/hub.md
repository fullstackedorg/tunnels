# Hub

```mermaid
flowchart TD
    Proxy["TLS Reverse Proxy"] --> HTTP["HTTP Server\n(PORT)"]
    HTTP --> Router{"Upgrade or Request?"}
    Router -->|"HTTP request"| API["REST API\n(/tunnels, /edges, custom routes)"]
    Router -->|"Upgrade"| Classify{"Token prefix"}
    Classify -->|"tun_"| Tunnel["Tunnel Handler"]
    Classify -->|"edg_"| Lifeline["Warden: Lifeline"]
    Classify -->|"edg_ + x-relay-worker"| Relayed["Warden: Relay Session"]
    Tunnel -->|"Direct"| Target[("Target")]
    Tunnel -->|"Relayed (streams)"| Relayed
    Lifeline -->|"open_relay"| Relayed
    API --> State[("Storage + KV")]
    Lifeline --> State
```

## Role

The Hub is selected when `HUB_URL` is not set. It:

1. Accepts runtime sockets and resolves tunnel tokens.
2. Performs **direct connections** to targets it can reach itself (tunnels with no `edgeId`).
3. Hosts Edge lifelines and bridges **relayed connections** through them (see [Warden](../3-subsystems/warden.md)).
4. Serves the [REST API](../3-subsystems/rest-api-router.md).

All settings are in the [Configuration Reference](configuration.md).

## Run Configurations

### Local Development

```bash
node src/main.ts --port 3000
```

Filesystem storage in `./data`, in-memory KV, plain `ws://localhost:3000`.

### Clustered Production

`WORKERS > 1` requires PostgreSQL and Redis; the Hub refuses to start otherwise (tests can use [`ALLOW_FILESYSTEM_MULTIWORKER`](configuration.md#test-mode-multi-worker-without-postgresql-or-redis) instead). Initialize the schema first (see [Schema Initialization](#schema-initialization)):

```bash
POSTGRES_URL="postgresql://postgres:secret@postgres:5432/tunnels" \
npx drizzle-kit push --config drizzle.config.ts

PORT=3000 \
WORKERS=4 \
POSTGRES_URL="postgresql://postgres:secret@postgres:5432/tunnels" \
REDIS_URL="redis://:secret@redis:6379" \
TRUSTED_PROXIES="10.0.0.0/8" \
node src/main.ts
```

Put a TLS-terminating reverse proxy in front (see [Deployment Requirement: TLS](configuration.md#deployment-requirement-tls)). Clustering is limited to one host.

### Docker Image

The published image is `fullstackedorg/tunnels` (linux/amd64 and linux/arm64), built from the repository's `Dockerfile`. It runs a Hub, or an Edge when `HUB_URL` is set (see [Edge › Docker](edge.md#docker)).

| Setting      | Value                                                                                                                                                                                       |
| :----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base         | `node:24-alpine`, production dependencies only (`npm ci --omit=dev`): `drizzle-kit` is not included, run [schema initialization](#schema-initialization) from a checkout.                   |
| Command      | `node src/main.ts`. Every [setting](configuration.md) works as an environment variable, or as CLI flags appended to the command.                                                            |
| Port         | `3000` (`EXPOSE`; `PORT` / `--port` still decide what the Hub listens on).                                                                                                                  |
| Data         | `DATA_DIR=/data`, a volume: filesystem storage writes `/data/store.json`. Unused with PostgreSQL.                                                                                           |
| User         | `node` (uid 1000). Mounted plugins and token files must be readable by it; a host directory mounted on `/data` must be writable by it.                                                      |
| Health check | Hub: any HTTP answer from `GET /edges?limit=1` (security hooks may answer `401`/`403`, which still proves the Hub serves). Edge: always healthy (no HTTP server; it reconnects on its own). |

A single Hub with filesystem storage:

```bash
docker run -d --name tunnels-hub --restart unless-stopped \
  -p 3000:3000 -v tunnels-data:/data \
  fullstackedorg/tunnels:0.1.0
```

Put a TLS-terminating reverse proxy in front before exposing it (see [Deployment Requirement: TLS](configuration.md#deployment-requirement-tls)).

### Docker Compose

```yaml
services:
    proxy:
        image: caddy:2-alpine
        # TLS termination; forwards WebSocket upgrades and sets X-Forwarded-For
        command: ["caddy", "reverse-proxy", "--from", "tunnels.example.com", "--to", "hub:3000"]
        ports:
            - "80:80"
            - "443:443"
        volumes:
            - caddy_data:/data
        networks:
            ingress:
                ipv4_address: 172.30.0.10

    hub:
        image: fullstackedorg/tunnels:0.1.0 # or build: { context: ., dockerfile: Dockerfile }
        # no published port: only the proxy reaches the Hub
        environment:
            PORT: 3000
            WORKERS: 4
            POSTGRES_URL: "postgresql://postgres:secret@postgres:5432/tunnels"
            REDIS_URL: "redis://:secret@redis:6379"
            TRUSTED_PROXIES: "172.30.0.10" # the proxy only
        networks:
            - ingress
            - default
        depends_on:
            postgres:
                condition: service_healthy
            redis:
                condition: service_healthy
        # health check: the image's own HEALTHCHECK

    postgres:
        image: postgres:16-alpine
        environment:
            POSTGRES_USER: postgres
            POSTGRES_PASSWORD: secret
            POSTGRES_DB: tunnels
        volumes:
            - pgdata:/var/lib/postgresql/data
        healthcheck:
            test: ["CMD-SHELL", "pg_isready -U postgres"]
            interval: 5s
            timeout: 5s
            retries: 5

    redis:
        image: redis:7-alpine
        command: ["redis-server", "--requirepass", "secret"]
        healthcheck:
            test: ["CMD", "redis-cli", "-a", "secret", "ping"]
            interval: 5s
            timeout: 5s
            retries: 5

networks:
    ingress:
        ipam:
            config:
                - subnet: 172.30.0.0/24

volumes:
    pgdata:
    caddy_data:
```

`TRUSTED_PROXIES` names only the proxy: `X-Forwarded-For` is trusted from no other address, so clients cannot spoof `req.clientIp`. Do not trust a whole Docker range while the Hub's port is published directly, since connections forwarded by Docker can arrive from the bridge gateway.

If a `rest_access` hook requires authentication, adjust the health check accordingly (or register a public route for it).

### Schema Initialization

PostgreSQL tables are managed manually with Drizzle Kit. Run this whenever the schema changes, before starting the new Hub version:

```bash
# From a repository checkout with dev dependencies installed (npm ci)
POSTGRES_URL="postgresql://..." npx drizzle-kit push --config drizzle.config.ts
```

`drizzle.config.ts` reads the database URL from `POSTGRES_URL`. `drizzle-kit` is a dev dependency: the Docker image (`npm ci --omit=dev`) does not include it, so run the command from a checkout (or a one-off container with dev dependencies), not from the Hub image.

On startup the Hub checks connectivity (`SELECT 1`) and that the `edge` and `tunnel` tables exist; if not, it exits with an error that names the command above. With `WORKERS > 1` this check runs in each worker, not the Primary: a worker that fails it (or fails to start for any other reason, such as PostgreSQL unreachable or the port in use) exits, and the Primary forks a replacement at once, with no backoff and no retry limit. The Primary keeps running and re-forking until it is stopped, so watch the logs for `Fatal startup error` and repeated `Forking replacement worker` lines.

## Provisioning

See the [REST API Reference](../3-subsystems/rest-api-router.md). Tokens are always generated by the Hub; clients cannot supply them.

## Graceful Shutdown

On `SIGINT` / `SIGTERM`:

1. **Stop ingress**: stop accepting new TCP connections (and so new upgrades).
2. **Close lifelines**: every lifeline is closed with `1001 hub_shutdown` and `lifeline_disconnect` fires; streams still waiting for a relay session fail with `hub_shutdown`. Edges reconnect with backoff.
3. **Stop the heartbeat sweep**: from here on no pings are sent and no connection is timed out, so a dead peer is only noticed when its socket errors or the drain ends.
4. **Drain sessions**: wait up to `SHUTDOWN_TIMEOUT` (default 30s) for tunnel **sessions** (WebSockets) to close, then close those still open with `1001 hub_shutdown`. `tunnel_end` fires for every stream. Open sessions keep accepting new streams (`OPEN`) during the drain. The runtime keeps its pooled sessions open as long as the tunnel is registered, so with connected runtimes the drain normally lasts the full `SHUTDOWN_TIMEOUT` and ends with a force-close.
5. **Close relay sessions**: after the drain, every relay session is closed with `1001 hub_shutdown`.
6. **Close providers**: `storage.close()` (flushes the filesystem store or ends the PostgreSQL pool) and `kv.close()`.
7. **Exit**: code `0` if every session closed on its own during the drain, `1` if any had to be force-closed (the usual case while runtimes are connected, see step 4).

In clustered mode the Primary forwards the signal to every worker, each worker runs the steps above, and the Primary exits after all workers have exited: with code `1` if any worker exited with a non-zero code, otherwise `0`. If workers are still alive `SHUTDOWN_TIMEOUT + 5s` after the signal, the Primary exits with code `1`.
