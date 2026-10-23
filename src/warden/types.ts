import type { Reason } from "../constants.ts";

export interface EdgeTunnel {
    id: string;
    name: string;
    internalHost: string;
    internalPort: number;
    metadata: Record<string, any>;
}

/** OPEN payload of a stream the Hub opens on an Edge's relay session (JSON). */
export interface RelayStreamOpen {
    reqId: string;
    tunnel: EdgeTunnel;
    client: {
        ip: string;
        correlationId?: string;
    };
    /** What is left of the Hub's connect budget when the stream opens. */
    connectTimeoutMs: number;
}

/** Hub → Edge (lifeline): dial one more relay session to the Hub worker `worker`. */
export interface OpenRelayOrder {
    type: "open_relay";
    worker: string;
}

/** Edge → Hub (lifeline): the relay session asked for by `worker` could not be dialed. */
export interface OpenRelayFailed {
    type: "open_relay_failed";
    worker: string;
}

/** Worker → lifeline worker: send `open_relay` for `worker` on the Edge's lifeline. */
export interface IpcRelayRequest {
    type: "relay_request";
    target: string;
    edgeId: string;
    worker: string;
}

/** Lifeline worker → worker: the Edge could not dial the relay session it asked for. */
export interface IpcRelayFailed {
    type: "relay_failed";
    target: string;
    edgeId: string;
    reason?: Reason;
}

/** A relay session socket for another worker (the socket travels as the IPC handle). */
export interface IpcRelaySessionSocket {
    type: "relay_session_socket";
    target: string;
    edgeId: string;
    head: Buffer;
    headers: Record<string, any>;
}

export interface IpcCloseLifeline {
    type: "close_lifeline";
    target: string;
    edgeId: string;
    reason: Reason;
}

export interface IpcSeverSessions {
    type: "sever_sessions";
    tunnelId?: string;
    edgeId?: string;
    reason: Reason;
}

export type WardenIpcMessage =
    IpcRelayRequest | IpcRelayFailed | IpcRelaySessionSocket | IpcCloseLifeline | IpcSeverSessions;
