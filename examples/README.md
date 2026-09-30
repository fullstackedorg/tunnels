# Cookbook & Examples

Every service recipe has two steps:

1. **Register the tunnel** on the Hub through the REST API. The Hub generates the token and returns it.
2. **Connect from the FullStacked runtime** with `tunnel.register({ host, authorization })`, where `host` is the Hub's address (`host:port`) and `authorization` is the tunnel token. It returns a virtual host for native drivers; each driver connection opens its own WebSocket to the Hub, so connection pools work unchanged. The Hub always connects to the tunnel's `internalHost:internalPort`; the port configured in the driver follows the usual convention for that service and does not affect routing.

> [!NOTE]
> The `fullstacked/tunnel` module is built directly into the FullStacked runtime. Execute any example script with:
>
> ```bash
> npx fullstacked --file examples/test-pg.ts
> ```

The examples use a local Hub (`localhost:3000`). For a Hub on the internet, use its public address behind a TLS proxy (see [Configuration](../docs/2-nodes/configuration.md#deployment-requirement-tls)).

## Contents

- [1. PostgreSQL](#1-postgresql)
- [2. Redis](#2-redis)
- [3. MySQL / MariaDB](#3-mysql--mariadb)
- [4. S3 / MinIO](#4-s3--minio)
- [5. HTTP APIs](#5-http-apis)
- [6. Targets Behind an Edge](#6-targets-behind-an-edge)
- [7. A Security Hook](#7-a-security-hook)
- [8. Metering Bytes (Plugin)](#8-metering-bytes-plugin)
- [9. Multi-Tenancy](#9-multi-tenancy)

---

## 1. PostgreSQL

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -d '{ "name": "postgres-prod", "internalHost": "127.0.0.1", "internalPort": 5432 }'
# { "id": "e4b1b36e-...", "token": "tun_4f8a9e2d1c3b...", "name": "postgres-prod",
#   "internalHost": "127.0.0.1", "internalPort": 5432, "edgeId": null, "metadata": {} }
```

```typescript
// test-pg.ts
import tunnel from "fullstacked/tunnel";
import pg from "pg";

const host = await tunnel.register({
    host: "localhost:3000",
    authorization: "tun_4f8a9e2d1c3b...",
});

const pool = new pg.Pool({
    host,
    port: 5432,
    user: "postgres",
    password: "password",
    database: "postgres",
});
const { rows } = await pool.query("SELECT NOW()");
console.log(rows[0]);
await pool.end();
```

## 2. Redis

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -d '{ "name": "redis-cache", "internalHost": "127.0.0.1", "internalPort": 6379 }'
```

```typescript
import tunnel from "fullstacked/tunnel";
import { createClient } from "redis";

const host = await tunnel.register({
    host: "localhost:3000",
    authorization: "tun_9b2c3d4e5f6a...",
});

const client = createClient({ url: `redis://${host}:6379` });
await client.connect();
await client.set("greeting", "Hello from tunneled Redis");
console.log(await client.get("greeting"));
await client.quit();
```

## 3. MySQL / MariaDB

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -d '{ "name": "mysql-db", "internalHost": "127.0.0.1", "internalPort": 3306 }'
```

```typescript
import tunnel from "fullstacked/tunnel";
import mysql from "mysql2/promise";

const host = await tunnel.register({
    host: "localhost:3000",
    authorization: "tun_7a1f2e3d4c5b...",
});

const connection = await mysql.createConnection({
    host,
    port: 3306,
    user: "root",
    password: "password",
    database: "test",
});
const [rows] = await connection.execute("SELECT 1 + 1 AS solution");
console.log(rows);
await connection.end();
```

## 4. S3 / MinIO

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -d '{ "name": "minio-s3", "internalHost": "127.0.0.1", "internalPort": 9000 }'
```

```typescript
import tunnel from "fullstacked/tunnel";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";

const host = await tunnel.register({
    host: "localhost:3000",
    authorization: "tun_3c8e1a2b5d4e...",
});

const s3 = new S3Client({
    endpoint: `http://${host}:9000`,
    region: "us-east-1",
    credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
    forcePathStyle: true,
});
const { Buckets } = await s3.send(new ListBucketsCommand({}));
console.log(Buckets);
```

## 5. HTTP APIs

```bash
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -d '{ "name": "internal-api", "internalHost": "127.0.0.1", "internalPort": 8080 }'
```

```typescript
// test-fetch.ts
import tunnel from "fullstacked/tunnel";

const host = await tunnel.register({
    host: "localhost:3000",
    authorization: "tun_1b5e9f8a2c4d...",
});

const response = await fetch(`http://${host}:8080/health`);
console.log(await response.json());
```

## 6. Targets Behind an Edge

```bash
# 1. Register the Edge
curl -X POST http://localhost:3000/edges \
  -H "Content-Type: application/json" \
  -d '{ "name": "remote-pi" }'
# { "id": "a1c2e3d4-7117-48f5-9cf2-4916a04874b3", "token": "edg_9a8b7c6d...", "name": "remote-pi", ... }

# 2. Register a tunnel bound to it
curl -X POST http://localhost:3000/tunnels \
  -H "Content-Type: application/json" \
  -d '{ "name": "pi-postgres", "internalHost": "127.0.0.1", "internalPort": 5432, "edgeId": "a1c2e3d4-7117-48f5-9cf2-4916a04874b3" }'
```

On the Raspberry Pi (no inbound ports needed):

```bash
HUB_URL="wss://tunnels.example.com" TOKEN="edg_9a8b7c6d..." node src/main.ts
```

From any FullStacked runtime:

```typescript
import tunnel from "fullstacked/tunnel";
import pg from "pg";

const host = await tunnel.register({
    host: "tunnels.example.com:443",
    authorization: "tun_1a2b3c4d...",
});

const pool = new pg.Pool({ host, port: 5432, user: "postgres" });
console.log((await pool.query("SELECT NOW()")).rows[0]);
await pool.end();
```

## 7. A Security Hook

Allow runtime connections only from the local network. `req.clientIp` honors `TRUSTED_PROXIES`.

```typescript
// plugins/local-only.ts, loaded with --plugin ./plugins/local-only.ts
import { registerHook } from "../src/utils/hooks.ts";

registerHook("tunnel_request", (req) => {
    if (req.clientIp !== "127.0.0.1" && !req.clientIp.startsWith("192.168.")) req.deny(); // 403
});
```

More recipes: [Extending Security](../docs/4-extensibility/extending-security.md).

## 8. Metering Bytes (Plugin)

[`track-bandwidth-hook.ts`](track-bandwidth-hook.ts) registers its hooks when imported, so it works directly as a plugin on a Hub or an Edge:

```bash
node src/main.ts --plugin ./examples/track-bandwidth-hook.ts
```

It uses `tunnel_connected` (Hub) and `edge_tunnel_connected` (Edge), which run before the streams resume, so every byte is counted. More recipes: [Extending Monitoring](../docs/4-extensibility/extending-monitoring.md).

## 9. Multi-Tenancy

Scoping every REST operation to a tenant, stamping ownership, protecting ownership keys, and checking that a tunnel can only use its own tenant's Edge are covered in one place: [Extending Security, Recipe 5](../docs/4-extensibility/extending-security.md#recipe-5-multi-tenancy).
