export const CLOSE_CODES = {
    normal: 1000,
    going_away: 1001,
    policy_violation: 1008,
    internal_error: 1011,
    try_again_later: 1013,
    bad_gateway: 1014,

    // Reason mappings
    client_close: 1000,
    target_close: 1000,
    token_rolled: 1000,
    tunnel_deleted: 1000,
    tunnel_updated: 1000,
    edge_deleted: 1000,
    superseded: 1000,
    client_aborted: 1000,

    hub_shutdown: 1001,
    edge_shutdown: 1001,

    hook_denied: 1008,

    hook_error: 1011,
    stream_error: 1011,
    target_worker_dead: 1011,
    heartbeat_timeout: 1011,

    edge_saturated: 1013,

    target_unreachable: 1014,
    connect_timeout: 1014,
    relay_dial_failed: 1014,
    edge_disconnected: 1014,
} as const;

export type Reason =
    | "client_close"
    | "target_close"
    | "client_aborted"
    | "target_unreachable"
    | "connect_timeout"
    | "relay_dial_failed"
    | "edge_disconnected"
    | "edge_saturated"
    | "target_worker_dead"
    | "hook_denied"
    | "hook_error"
    | "stream_error"
    | "heartbeat_timeout"
    | "token_rolled"
    | "tunnel_deleted"
    | "tunnel_updated"
    | "edge_deleted"
    | "superseded"
    | "hub_shutdown"
    | "edge_shutdown";

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_HEARTBEAT_INTERVAL = 10;
export const DEFAULT_HEARTBEAT_TIMEOUT = 30;
export const DEFAULT_HOOK_TIMEOUT = 5;
export const DEFAULT_CONNECT_TIMEOUT = 10;
export const DEFAULT_SHUTDOWN_TIMEOUT = 30;
export const DEFAULT_DRAIN_TIMEOUT = 30;
export const DEFAULT_REVOKED_POLL_INTERVAL = 300;
export const DEFAULT_ENTITY_CACHE_TTL = 60;
export const DEFAULT_NEGATIVE_CACHE_TTL = 5;
export const DEFAULT_MAX_PENDING_ORDERS = 1000;
export const DEFAULT_MAX_LIFELINE_BUFFER = 1048576;
export const DEFAULT_DATA_DIR = "data";
export const DEFAULT_WORKERS = 1;
export const DEFAULT_RECONNECT_INTERVAL = 1;
export const DEFAULT_MAX_RECONNECT_INTERVAL = 30;
