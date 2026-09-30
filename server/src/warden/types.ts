import type { Reason } from "../constants.ts";

export interface EdgeTunnel {
    id: string;
    name: string;
    internalHost: string;
    internalPort: number;
    metadata: Record<string, any>;
}

export interface ConnectTunnelOrder {
    type: "connect_tunnel";
    reqId: string;
    ticket: string;
    tunnel: EdgeTunnel;
    client: {
        ip: string;
        correlationId?: string;
    };
    connectTimeoutMs: number;
}

export interface CancelTunnelOrder {
    type: "cancel_tunnel";
    reqId: string;
    ticket: string;
    reason: Reason;
}

export interface ConnectTunnelFailedOrder {
    type: "connect_tunnel_failed";
    reqId: string;
    ticket: string;
    reason: Reason;
}

export type LifelineOrder = ConnectTunnelOrder | CancelTunnelOrder | ConnectTunnelFailedOrder;

export interface ActiveTicketData {
    originWorker: string;
    lifelineWorker: string;
    edgeId: string;
    reqId: string;
    tunnelId: string;
}

export interface CancelledTicketData {
    status: "cancelled";
    reason: Reason;
}

export type TicketData = ActiveTicketData | CancelledTicketData;

export interface IpcRelayedTunnelRequest {
    type: "relayed_tunnel_request";
    target: string;
    ticket: string;
    reqId: string;
    edgeId: string;
    tunnel: EdgeTunnel;
    client: {
        ip: string;
        correlationId?: string;
    };
    deadline: number;
    originWorker: string;
}

export interface IpcRelayedTunnelCancel {
    type: "relayed_tunnel_cancel";
    target: string;
    ticket: string;
    reason: Reason;
}

export interface IpcRelayedTunnelFailed {
    type: "relayed_tunnel_failed";
    target: string;
    ticket: string;
    reason: Reason;
}

export interface IpcRelayedTunnelSocket {
    type: "relayed_tunnel_socket";
    target: string;
    ticket: string;
    head: Buffer;
    headers: Record<string, any>;
}

export interface IpcRelayedTunnelHandoff {
    type: "relayed_tunnel_handoff";
    target: string;
    ticket: string;
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
    | IpcRelayedTunnelRequest
    | IpcRelayedTunnelCancel
    | IpcRelayedTunnelFailed
    | IpcRelayedTunnelSocket
    | IpcRelayedTunnelHandoff
    | IpcCloseLifeline
    | IpcSeverSessions;
