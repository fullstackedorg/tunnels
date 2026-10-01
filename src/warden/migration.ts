import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import { CLOSE_CODES, type Reason } from "../constants.ts";
import { logger } from "../utils/logger.ts";
import { claimTicket } from "./tickets.ts";
import { createWebSocketServer } from "../ws/index.ts";
import { createWsDuplex } from "../utils/ws-stream.ts";
import { registerHeartbeat } from "../ws/heartbeat.ts";
import { deletePendingOrder } from "./orders.ts";

export interface ParkedRelayedRequest {
    resolve: (stream: Duplex) => void;
    reject: (reason: Reason) => void;
    lifelineWorker: string;
    reqId: string;
    deadline: number;
    timer?: NodeJS.Timeout;
}

const parkedRequests = new Map<string, ParkedRelayedRequest>();
let clusterIpcSender: ((msg: any, handle?: any) => void) | null = null;

export function setMigrationIpcSender(sender: ((msg: any, handle?: any) => void) | null): void {
    clusterIpcSender = sender;
}

export function parkRelayedRequest(ticket: string, record: ParkedRelayedRequest): void {
    parkedRequests.set(ticket, record);
}

export function getParkedRelayedRequest(ticket: string): ParkedRelayedRequest | undefined {
    return parkedRequests.get(ticket);
}

export function deleteParkedRelayedRequest(ticket: string): ParkedRelayedRequest | undefined {
    const p = parkedRequests.get(ticket);
    if (p) {
        if (p.timer) clearTimeout(p.timer);
        parkedRequests.delete(ticket);
    }
    return p;
}

export function failRelayedRequest(ticket: string, reason: Reason): void {
    const parked = deleteParkedRelayedRequest(ticket);
    if (parked) {
        parked.reject(reason);
    }
}

export function failAllParkedRequests(reason: Reason): void {
    for (const [ticket, parked] of parkedRequests.entries()) {
        if (parked.timer) clearTimeout(parked.timer);
        parkedRequests.delete(ticket);
        parked.reject(reason);
    }
}

export function notifyHandoff(ticket: string, lifelineWorker: string): void {
    const workerId = logger.getWorkerIdentity();
    if (lifelineWorker === workerId) {
        deletePendingOrder(ticket);
    } else if (clusterIpcSender) {
        clusterIpcSender({
            type: "relayed_tunnel_handoff",
            target: lifelineWorker,
            ticket,
        });
    }
}

/**
 * Completes handoff on the origin worker:
 * - Upgrades the incoming raw socket to WebSocket
 * - Registers in heartbeat sweep
 * - Wraps with Duplex
 * - Resolves the parked promise
 * - Notifies lifeline worker of handoff
 */
export function completeHandoff(
    ticket: string,
    reqAdapter: IncomingMessage,
    socket: Duplex,
    head: Buffer
): boolean {
    const parked = deleteParkedRelayedRequest(ticket);
    if (!parked) {
        socket.destroy();
        return false;
    }

    const wss = createWebSocketServer();
    wss.handleUpgrade(reqAdapter, socket, head, (ws) => {
        registerHeartbeat(ws);
        const duplex = createWsDuplex(ws);
        notifyHandoff(ticket, parked.lifelineWorker);
        parked.resolve(duplex);
    });

    return true;
}

/**
 * Handles incoming raw socket migrated from another worker via Primary IPC.
 */
export function handleMigratedSocket(
    ticket: string,
    head: Buffer,
    headers: Record<string, any>,
    socket: Duplex
): void {
    const reqAdapter = {
        method: "GET",
        url: "/",
        headers,
        socket,
    } as unknown as IncomingMessage;

    completeHandoff(ticket, reqAdapter, socket, head);
}

/** Relayed socket arrival (tmp_ ticket): claim, then hand off locally or migrate. */
export async function wardenRelayedSocket(
    req: IncomingMessageWithDeny,
    socket: Duplex,
    head: Buffer
): Promise<void> {
    const ticket = req.headers.authorization;
    if (!ticket || !ticket.startsWith("tmp_")) {
        req.deny(401, "Unauthorized");
        return;
    }

    let claimed;
    try {
        claimed = await claimTicket(ticket);
    } catch {
        req.deny(503, "Service Unavailable");
        return;
    }
    if (!claimed) {
        req.deny(401, "Unauthorized");
        return;
    }

    if ("status" in claimed && claimed.status === "cancelled") {
        const reason = (claimed as any).reason as Reason;
        const code = CLOSE_CODES[reason] ?? 1000;
        const wss = createWebSocketServer();
        wss.handleUpgrade(req, socket, head, (ws) => {
            try {
                ws.close(code, reason);
            } catch {
                socket.destroy();
            }
        });
        return;
    }

    const active = claimed as any;
    const currentWorker = logger.getWorkerIdentity();

    if (active.originWorker === currentWorker) {
        completeHandoff(ticket, req, socket, head);
    } else if (clusterIpcSender) {
        clusterIpcSender(
            {
                type: "relayed_tunnel_socket",
                target: active.originWorker,
                lifelineWorker: active.lifelineWorker,
                ticket,
                head,
                headers: req.headers,
            },
            socket
        );
    } else {
        socket.destroy();
    }
}
