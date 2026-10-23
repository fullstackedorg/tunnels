# System Architecture & Topology

```mermaid
flowchart LR
    subgraph RuntimeZone["FullStacked Runtime Environments (Laptop, Smartphone, Workstation, CI)"]
        AppLogic["Application Logic\n(Native Drivers: pg, redis, fetch, S3 SDK)"]
        TunnelSocket["Tunnel Sessions\n(Authorization: tunnel token)"]
        AppLogic --> TunnelSocket
    end

    subgraph HubZone["Public Ingress (Cloud / VPS)"]
        Proxy["TLS Reverse Proxy\n(Port 443)"]
        Hub["Hub\n(Plain HTTP/WS, e.g. Port 3000)"]
        KVStore[("KV Store\n(Memory / Redis)")]
        Storage[("Storage\n(Filesystem / PostgreSQL)")]
        Proxy --> Hub
        Hub <--> KVStore
        Hub <--> Storage
    end

    subgraph CoLocated["Hub Network"]
        VpcDB[("Co-Located Services")]
    end

    subgraph PrivateNet["Private Network (No Inbound Ports)"]
        Edge["Edge\n(Outbound Only)"]
        PrivDB[("PostgreSQL")]
        PrivRedis[("Redis")]
        PrivAPI["Internal API"]
        Edge -->|"Target Sockets"| PrivDB
        Edge -->|"Target Sockets"| PrivRedis
        Edge -->|"Target Sockets"| PrivAPI
    end

    TunnelSocket ===>|"WSS"| Proxy
    Hub -->|"Direct Connection"| VpcDB
    Edge ===>|"Lifeline (edge token)"| Proxy
    Edge ===>|"Relay Sessions (edge token)"| Proxy

    classDef runtime fill:#1f2937,stroke:#3b82f6,stroke-width:2px,color:#fff;
    classDef hub fill:#1e1b4b,stroke:#8b5cf6,stroke-width:2px,color:#fff;
    classDef edge fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#fff;
    classDef storage fill:#374151,stroke:#9ca3af,stroke-width:1px,color:#fff;

    class AppLogic,TunnelSocket runtime;
    class Hub,Proxy hub;
    class Edge,PrivDB,PrivRedis,PrivAPI edge;
    class KVStore,Storage,VpcDB storage;
```

## Roles

Terms used below are defined in the [Glossary](glossary.md).

1. **Hub**: the public server. It terminates tunnel sessions, resolves tokens, performs direct connections to services it can reach itself, hosts Edge lifelines, and bridges relayed connections. It speaks plain HTTP/WS; TLS is terminated by a reverse proxy in front of it (see [Configuration](../2-nodes/configuration.md#deployment-requirement-tls)).
2. **Edge**: an outbound-only daemon inside a private network. It keeps one lifeline to the Hub, dials relay sessions back to the Hub when ordered to, and for each stream the Hub opens on them dials the target.
3. **FullStacked runtime**: `tunnel.register({ host, authorization })` registers a virtual route in the runtime's network resolver and returns a virtual host. `host` is the Hub's address as `host:port`; `authorization` is the tunnel token. The runtime holds tunnel sessions to the Hub (one WebSocket each, gated once at the upgrade), a pool per registered tunnel that grows when its sessions are busy; every driver connection to the virtual host is a stream on one of them (`OPEN` / `OPENED` / `DATA` / `WINDOW` / `FIN` / `RESET`, see [Data Framing](protocol-spec.md#4-data-framing)), so connection pools work unchanged. The port the driver uses on the virtual host is not sent to the Hub: the target is always the tunnel's `internalHost:internalPort`.

A **direct connection** is used when the tunnel has no `edgeId`; a **relayed connection** when it does.

---

## Direct Connection Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Runtime as FullStacked Runtime
    participant Hub as Hub
    participant Target as Target (Hub Network)

    Runtime->>Hub: Upgrade (Authorization: tunnel token)
    Hub->>Hub: hub_upgrade hook
    Hub->>Hub: Resolve tunnel (cache, then storage)
    Hub->>Hub: tunnel_request hook
    Hub-->>Runtime: 101 Switching Protocols (tunnel session)
    Runtime->>Hub: OPEN (stream)
    Hub->>Hub: tunnel_start (telemetry)
    Hub->>Target: TCP connect (connect timer: CONNECT_TIMEOUT)
    alt Target Reachable
        Target-->>Hub: Connected
        Hub-->>Runtime: OPENED
        Hub->>Hub: Splice, await tunnel_connected
        Runtime<<->>Target: Byte stream
        Runtime->>Hub: FIN (or target FIN)
        Hub->>Target: Close
        Hub->>Hub: tunnel_end (client_close / target_close)
    else Refused / Timeout
        Hub-->>Runtime: RESET (target_unreachable / connect_timeout)
        Hub->>Hub: tunnel_end (same reason)
    end
```

---

## Relayed Connection Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Runtime as FullStacked Runtime
    participant Hub as Hub
    participant Edge as Edge
    participant Target as Target (Private Network)

    Edge->>Hub: Lifeline upgrade (Authorization: edge token)
    Hub-->>Edge: 101 (heartbeat active on both sides)
    Hub->>Edge: open_relay { worker } (one warm relay session)
    Edge->>Hub: Relay session upgrade (edge token, x-relay-worker)
    Hub-->>Edge: 101 (relay session)

    Runtime->>Hub: Upgrade (Authorization: tunnel token)
    Hub->>Hub: hub_upgrade, resolve tunnel, tunnel_request
    Hub-->>Runtime: 101 (tunnel session)
    Runtime->>Hub: OPEN (stream), deadline = now + CONNECT_TIMEOUT
    alt Edge Offline (no presence)
        Hub-->>Runtime: RESET edge_disconnected
    else Edge Online
        Hub->>Hub: tunnel_start
        opt No relay session of the Edge on this worker
            Hub->>Edge: open_relay { worker } (via the lifeline worker)
            Edge->>Hub: Relay session upgrade (edge token, x-relay-worker)
        end
        opt Chosen relay session already carries 256 streams
            Hub-->>Runtime: RESET edge_saturated, tunnel_end
        end
        Hub->>Edge: OPEN { reqId, tunnel, client, connectTimeoutMs } (relay session)
        Edge->>Edge: edge_tunnel_request, edge_tunnel_start
        Edge->>Target: TCP connect (bounded by connectTimeoutMs)
        alt Target Connected
            Edge-->>Hub: OPENED
            Edge->>Edge: Splice, await edge_tunnel_connected
            Hub-->>Runtime: OPENED
            Hub->>Hub: Splice, await tunnel_connected
            Runtime<<->>Target: Byte stream
        else Target Fails / Edge Timer Expires / Gate Denies
            Edge-->>Hub: RESET target_unreachable / connect_timeout / hook_denied / hook_error
            Hub-->>Runtime: RESET (same reason, verbatim)
        else No Relay Session Could Be Dialed
            Edge->>Hub: open_relay_failed { worker } (lifeline)
            Hub-->>Runtime: RESET relay_dial_failed
        else Runtime Ends the Stream First
            Hub->>Hub: tunnel_end (client_aborted)
            Hub->>Edge: RESET client_aborted
            Edge->>Target: Destroy in-flight dial
        else Deadline Passes
            Hub-->>Runtime: RESET connect_timeout
            Hub->>Edge: RESET connect_timeout
        end
    end
```

All failure reasons and close codes are defined in the [Protocol Spec](protocol-spec.md#close-reason-taxonomy). Timers are defined in [Connection Establishment Budget](protocol-spec.md#connection-establishment-budget).

---

## Trust Boundaries

- **Out of the box, nothing is authenticated beyond token possession.** Anyone who can reach the REST API can create tunnels, including direct tunnels to any host the Hub can reach. This is deliberate for tinkering; production deployments add security through [hooks](../4-extensibility/extending-security.md).
- **Tokens are bearer secrets.** Possessing a tunnel token grants access to its target; possessing an edge token lets a daemon impersonate that Edge.
- **The Edge trusts the Hub.** It dials whatever target an `OPEN` from the Hub names; restrict this with an `edge_tunnel_request` hook if the Hub is not fully trusted.
- **TLS is provided by the reverse proxy**, never by the Hub itself.
