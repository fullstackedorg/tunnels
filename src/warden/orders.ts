import type { WebSocket } from "ws";
import type { Reason } from "../constants.ts";
import type { ConnectTunnelOrder, EdgeTunnel } from "./types.ts";
import { DEFAULT_MAX_PENDING_ORDERS, DEFAULT_MAX_LIFELINE_BUFFER } from "../constants.ts";

export interface PendingOrder {
    originWorker: string;
    reqId: string;
    edgeId: string;
    expiresAt: number;
    /** The lifeline the order was written on (lifeline worker only). */
    lifeline?: WebSocket;
}

const pendingOrders = new Map<string, PendingOrder>();
let maxPendingOrders = DEFAULT_MAX_PENDING_ORDERS;
let maxLifelineBuffer = DEFAULT_MAX_LIFELINE_BUFFER;

export function setSaturationLimits(maxOrders: number, maxBuffer: number): void {
    maxPendingOrders = maxOrders;
    maxLifelineBuffer = maxBuffer;
}

export function isLifelineSaturated(edgeId: string, ws: WebSocket): boolean {
    let edgeOrderCount = 0;
    for (const order of pendingOrders.values()) {
        if (order.edgeId === edgeId) {
            edgeOrderCount++;
        }
    }
    if (edgeOrderCount >= maxPendingOrders) {
        return true;
    }
    if (ws.bufferedAmount > maxLifelineBuffer) {
        return true;
    }
    return false;
}

export function recordPendingOrder(ticket: string, order: PendingOrder): void {
    pendingOrders.set(ticket, order);
}

export function getPendingOrder(ticket: string): PendingOrder | undefined {
    return pendingOrders.get(ticket);
}

export function deletePendingOrder(ticket: string): boolean {
    return pendingOrders.delete(ticket);
}

/** Pending orders of an Edge, optionally only those written on one lifeline. */
export function getPendingOrdersForEdge(
    edgeId: string,
    lifeline?: WebSocket
): Array<{ ticket: string; order: PendingOrder }> {
    const list: Array<{ ticket: string; order: PendingOrder }> = [];
    for (const [ticket, order] of pendingOrders.entries()) {
        if (order.edgeId === edgeId && (!lifeline || order.lifeline === lifeline)) {
            list.push({ ticket, order });
        }
    }
    return list;
}

export function sendConnectTunnel(
    ws: WebSocket,
    ticket: string,
    reqId: string,
    tunnel: EdgeTunnel,
    client: { ip: string; correlationId?: string },
    deadline: number,
    originWorker: string,
    edgeId: string
): boolean {
    const connectTimeoutMs = deadline - Date.now();
    if (connectTimeoutMs <= 0) {
        return false;
    }

    const order: ConnectTunnelOrder = {
        type: "connect_tunnel",
        reqId,
        ticket,
        tunnel,
        client,
        connectTimeoutMs,
    };

    recordPendingOrder(ticket, {
        originWorker,
        reqId,
        edgeId,
        expiresAt: deadline + 2000,
        lifeline: ws,
    });

    try {
        ws.send(JSON.stringify(order));
        return true;
    } catch {
        deletePendingOrder(ticket);
        return false;
    }
}

export function sendCancelTunnel(
    ws: WebSocket,
    ticket: string,
    reqId: string,
    reason: Reason
): void {
    deletePendingOrder(ticket);
    try {
        ws.send(JSON.stringify({ type: "cancel_tunnel", reqId, ticket, reason }));
    } catch {
        // ignore send error
    }
}

export function pruneExpiredOrders(): void {
    const now = Date.now();
    for (const [ticket, order] of pendingOrders.entries()) {
        if (order.expiresAt <= now) {
            pendingOrders.delete(ticket);
        }
    }
}
