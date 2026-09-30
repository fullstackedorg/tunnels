# Glossary

Every document in this repository uses the terms below with exactly these meanings. When a document needs one of these concepts it uses the term as written here and links back to this page instead of re-defining it.

## Nodes and Processes

| Term                              | Definition                                                                                                                                                                                     |
| :-------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hub**                           | The public server. Accepts runtime sockets, hosts lifelines, serves the REST API, and performs direct connections. Selected when `HUB_URL` is not set. See [Hub](../2-nodes/hub.md).           |
| **Edge**                          | An outbound-only daemon running inside a private network. Holds one lifeline to the Hub and dials targets on the Hub's behalf. Selected when `HUB_URL` is set. See [Edge](../2-nodes/edge.md). |
| **FullStacked runtime** (runtime) | The client environment that runs application code and native drivers. It opens runtime sockets to the Hub through `tunnel.register`.                                                           |
| **Primary**                       | In multi-worker mode (`WORKERS > 1`), the parent process that forks workers and brokers IPC between them. It never carries tunnel data itself.                                                 |
| **Worker**                        | A forked process that serves connections. In single-process mode (`WORKERS = 1`) the only process is treated as worker `1`.                                                                    |
| **Worker identity**               | `<bootId>:<workerId>`. `bootId` is a random value generated each time the Hub starts, so identities from a previous run never match a live worker.                                             |
| **Origin worker**                 | The Hub worker that holds a runtime socket waiting for a relayed connection.                                                                                                                   |
| **Lifeline worker**               | The Hub worker that holds a given Edge's lifeline.                                                                                                                                             |
| **Receiving worker**              | The Hub worker on which a relayed socket happens to arrive. It may or may not be the origin worker.                                                                                            |

## Entities and Credentials

| Term              | Definition                                                                                                                                                                                                   |
| :---------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tunnel**        | A stored entity describing one reachable target: `internalHost`, `internalPort`, and an optional `edgeId`. Identified to clients by a tunnel token. See [Entity Schemas](../3-subsystems/entity-schemas.md). |
| **Edge entity**   | A stored entity describing one Edge daemon. Identified to the daemon by an edge token.                                                                                                                       |
| **Tunnel token**  | `tun_` + 32 random bytes (base64url). Bearer secret presented by the runtime.                                                                                                                                |
| **Edge token**    | `edg_` + 32 random bytes (base64url). Bearer secret presented by an Edge on its lifeline.                                                                                                                    |
| **Ticket**        | `tmp_` + 32 random bytes (base64url). Single-use bearer secret the Hub issues for one relayed socket. Stored in KV as `relayed_request:<ticket>` and claimed atomically with `getdel`.                       |
| **Bearer secret** | Any token whose possession alone grants access. All three token kinds are bearer secrets and must be handled like passwords.                                                                                 |

## Connections

| Term                   | Definition                                                                                                                                                                                                                                                       |
| :--------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Target**             | The TCP service a tunnel points at (`internalHost:internalPort`).                                                                                                                                                                                                |
| **Target socket**      | The plain TCP connection from the Hub (direct) or the Edge (relayed) to the target.                                                                                                                                                                              |
| **Runtime socket**     | The WebSocket from the runtime to the Hub, presenting a tunnel token.                                                                                                                                                                                            |
| **Lifeline**           | The persistent control WebSocket from an Edge to the Hub, presenting an edge token. It carries orders and heartbeats, never tunnel data.                                                                                                                         |
| **Relayed socket**     | A WebSocket from an Edge to the Hub, presenting a ticket, that carries the data of exactly one session.                                                                                                                                                          |
| **Direct connection**  | A session whose tunnel has no `edgeId`: the Hub dials the target itself.                                                                                                                                                                                         |
| **Relayed connection** | A session whose tunnel has an `edgeId`: data flows runtime socket → Hub → relayed socket → Edge → target socket.                                                                                                                                                 |
| **Session**            | One end-to-end byte stream between a runtime socket and a target, from runtime upgrade acceptance until teardown. `tunnel_start` and `tunnel_end` bracket every session on the Hub; `edge_tunnel_start` and `edge_tunnel_end` bracket every session on the Edge. |

## Protocol

| Term                | Definition                                                                                                                                                                                                    |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Order**           | A JSON text frame on a lifeline (`connect_tunnel`, `cancel_tunnel`, `connect_tunnel_failed`). See [Protocol Spec](protocol-spec.md#2-lifeline-protocol).                                                      |
| **Pending order**   | An order the Hub has sent and that is not yet acknowledged.                                                                                                                                                   |
| **Acknowledgement** | An order is acknowledged by handoff or by a `connect_tunnel_failed` frame. There is no separate ack message.                                                                                                  |
| **Handoff**         | The moment the Hub accepts a relayed socket (ticket claimed and upgrade completed). Before handoff, relayed failures are reported with `connect_tunnel_failed`; after handoff, by closing the relayed socket. |
| **Deadline**        | `runtime upgrade acceptance + CONNECT_TIMEOUT`. The single budget for establishing a session. See [Connection Establishment Budget](protocol-spec.md#connection-establishment-budget).                        |
| **Heartbeat**       | The bidirectional WebSocket ping/pong that runs on every WebSocket connection. See [Heartbeat](protocol-spec.md#3-heartbeat-all-websocket-connections).                                                       |
| **Reason**          | A snake_case string from the [close reason taxonomy](protocol-spec.md#close-reason-taxonomy). Reasons are the only strings ever sent in WebSocket close frames and passed to end-of-session hooks.            |
| **Revoked state**   | The Edge state entered after a `401` or an administrative lifeline closure: drain, then idle-poll. See [Edge](../2-nodes/edge.md#revocation-handling).                                                        |

## Extensibility

| Term               | Definition                                                                                                                                                                                          |
| :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hook**           | A named extension point. See [Hooks Catalog](../4-extensibility/hooks.md).                                                                                                                          |
| **Gating hook**    | A hook that can refuse an operation. Fail-closed.                                                                                                                                                   |
| **Scope hook**     | `scope_<table>`: the gating hook that restricts which rows a REST operation can see, evaluated before any storage read.                                                                             |
| **Telemetry hook** | A hook that observes but cannot refuse. Fail-open and not awaited on the data path (except `tunnel_connected` / `edge_tunnel_connected`, see [Hooks](../4-extensibility/hooks.md#execution-model)). |
| **Plugin**         | A module loaded with `--plugin` / `PLUGINS` that registers hooks or routes.                                                                                                                         |
