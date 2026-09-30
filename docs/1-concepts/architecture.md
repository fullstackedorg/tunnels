# System Architecture & Topology

```mermaid
flowchart LR
    subgraph RuntimeZone["FullStacked Runtime Environments (Laptop, Smartphone, Workstation, CI)"]
        AppLogic["Application Logic\n(Native Drivers: pg, redis, fetch, S3 SDK)"]
        TunnelSocket["Runtime Sockets\n(Authorization: tunnel token)"]
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
    Edge -.->|"Relayed Sockets (tickets)"| Proxy

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

1. **Hub**: the public server. It terminates runtime sockets, resolves tokens, performs direct connections to services it can reach itself, hosts Edge lifelines, and bridges relayed connections. It speaks plain HTTP/WS; TLS is terminated by a reverse proxy in front of it (see [Configuration](../2-nodes/configuration.md#deployment-requirement-tls)).
2. **Edge**: an outbound-only daemon inside a private network. It keeps one lifeline to the Hub and, per order, dials a target and opens a relayed socket back to the Hub.
3. **FullStacked runtime**: `tunnel.register({ host, authorization })` registers a virtual route in the runtime's network resolver and returns a virtual host. `host` is the Hub's address as `host:port`; `authorization` is the tunnel token. Every driver connection to the virtual host opens its own runtime socket to the Hub, so connection pools work unchanged. The port the driver uses on the virtual host is not sent to the Hub: the target is always the tunnel's `internalHost:internalPort`.

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
    Hub-->>Runtime: 101 Switching Protocols (runtime socket paused)
    Hub->>Hub: tunnel_start (telemetry)
    Hub->>Target: TCP connect (connect timer: CONNECT_TIMEOUT)
    alt Target Reachable
        Target-->>Hub: Connected
        Hub->>Hub: Attach pipelines, await tunnel_connected, resume streams
        Runtime<<->>Target: Byte stream
        Runtime->>Hub: Close (or target FIN)
        Hub->>Target: Close
        Hub->>Hub: tunnel_end (client_close / target_close)
    else Refused / Timeout
        Hub-->>Runtime: Close 1014 (target_unreachable / connect_timeout)
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

    Runtime->>Hub: Upgrade (Authorization: tunnel token)
    Hub->>Hub: hub_upgrade, resolve tunnel, tunnel_request
    Hub-->>Runtime: 101 (runtime socket paused), deadline = now + CONNECT_TIMEOUT
    alt Edge Offline
        Hub-->>Runtime: Close 1014 (edge_disconnected)
    else Edge Saturated
        Hub-->>Runtime: Close 1013 (edge_saturated)
    else Edge Online
        Hub->>Hub: tunnel_start, store ticket (TTL CONNECT_TIMEOUT + 2s)
        Hub->>Edge: connect_tunnel { reqId, ticket, tunnel, client, connectTimeoutMs }
        Edge->>Edge: edge_tunnel_request, edge_tunnel_start
        par Parallel Dials (bounded by connectTimeoutMs)
            Edge->>Target: TCP connect
        and
            Edge->>Hub: Relayed socket upgrade (Authorization: ticket)
        end
        alt Both Succeed
            Hub->>Hub: getdel ticket, accept relayed socket (handoff)
            Hub->>Hub: Attach pipelines, await tunnel_connected, resume
            Edge->>Edge: Attach pipelines, await edge_tunnel_connected, resume
            Runtime<<->>Target: Byte stream
        else Target Fails Before Handoff
            Edge->>Hub: Abort relayed dial, connect_tunnel_failed (target_unreachable / connect_timeout)
            Hub-->>Runtime: Close CLOSE_CODES[reason] (reason forwarded verbatim)
        else Target Fails After Handoff
            Edge-->>Hub: Close relayed socket 1014 (target_unreachable / connect_timeout)
            Hub-->>Runtime: Close 1014 (same reason)
        else Relayed Dial Fails
            Edge->>Target: Destroy target socket
            Edge->>Hub: connect_tunnel_failed (relay_dial_failed)
            Hub-->>Runtime: Close 1014 (relay_dial_failed)
        else Runtime Disconnects Before Handoff
            Hub->>Hub: Write ticket tombstone (5s), tunnel_end (client_aborted)
            Hub->>Edge: cancel_tunnel (client_aborted)
            Edge->>Target: Destroy in-flight dials
        else Deadline Passes
            Hub->>Hub: Write ticket tombstone (5s)
            Hub-->>Runtime: Close 1014 (connect_timeout)
            Hub->>Edge: cancel_tunnel (connect_timeout)
        end
    end
```

All failure reasons and close codes are defined in the [Protocol Spec](protocol-spec.md#close-reason-taxonomy). Timers are defined in [Connection Establishment Budget](protocol-spec.md#connection-establishment-budget).

---

## Trust Boundaries

- **Out of the box, nothing is authenticated beyond token possession.** Anyone who can reach the REST API can create tunnels, including direct tunnels to any host the Hub can reach. This is deliberate for tinkering; production deployments add security through [hooks](../4-extensibility/extending-security.md).
- **Tokens are bearer secrets.** Possessing a tunnel token grants access to its target; possessing an edge token lets a daemon impersonate that Edge.
- **The Edge trusts the Hub.** It dials whatever target an order names; restrict this with an `edge_tunnel_request` hook if the Hub is not fully trusted.
- **TLS is provided by the reverse proxy**, never by the Hub itself.
