import type { Duplex } from "node:stream";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import type { Reason } from "../constants.ts";
import { logger } from "../utils/logger.ts";
import { kv } from "../kv/index.ts";
import { DEFAULT_CONNECT_TIMEOUT } from "../constants.ts";
import { createTicket, claimTicket, cancelTicketTombstone, deleteTicket } from "./tickets.ts";
import {
    isLifelineSaturated,
    sendConnectTunnel,
    sendCancelTunnel,
    deletePendingOrder,
} from "./orders.ts";
import {
    getLocalLifeline,
    isEdgeOnline,
    wardenLifeline,
    closeLifelineLocally,
    setClusterIpcSender as setLifelineClusterIpc,
    setFailRelayedRequestFn,
} from "./lifeline.ts";
import {
    parkRelayedRequest,
    deleteParkedRelayedRequest,
    failRelayedRequest,
    completeHandoff,
    handleMigratedSocket,
    setMigrationIpcSender,
} from "./migration.ts";
import { createWebSocketServer } from "../ws/index.ts";
import { CLOSE_CODES } from "../constants.ts";

export {
    isEdgeOnline,
    wardenLifeline,
    closeLifelineLocally,
    closeLifeline,
    shutdownWarden,
    setWardenBootId,
} from "./lifeline.ts";
export { handleMigratedSocket } from "./migration.ts";

setFailRelayedRequestFn(failRelayedRequest);

let clusterIpcSender: ((msg: any, handle?: any) => void) | null = null;

export function setWardenClusterIpcSender(sender: ((msg: any, handle?: any) => void) | null): void {
    clusterIpcSender = sender;
    setLifelineClusterIpc(sender);
    setMigrationIpcSender(sender);
}

export async function acquireRelayedStream(
    tunnel: Tunnel,
    req: IncomingMessageWithDeny,
    deadline: number
): Promise<Duplex> {
    if (!tunnel.edgeId) {
        throw new Error("Cannot acquire relayed stream for direct tunnel");
    }

    const currentWorker = logger.getWorkerIdentity();
    const lifelineWorker = await kv.get<string>(`edge:${tunnel.edgeId}:worker`);
    if (!lifelineWorker) {
        const err: any = new Error("Edge is offline");
        err.reason = "edge_disconnected";
        throw err;
    }

    const ttlSeconds = DEFAULT_CONNECT_TIMEOUT + 2;
    const ticket = await createTicket(
        currentWorker,
        lifelineWorker,
        tunnel.edgeId,
        req.id,
        tunnel.id,
        ttlSeconds
    );

    return new Promise<Duplex>((resolve, reject) => {
        let isSettled = false;

        const notifyCancel = (reason: Reason) => {
            if (lifelineWorker === currentWorker) {
                const ws = getLocalLifeline(tunnel.edgeId!);
                if (ws) sendCancelTunnel(ws, ticket, req.id, reason);
            } else if (clusterIpcSender) {
                clusterIpcSender({
                    type: "relayed_tunnel_cancel",
                    target: lifelineWorker,
                    ticket,
                    reason,
                });
            }
        };

        const onRuntimeClose = async () => {
            if (isSettled) return;
            await cancelTicketTombstone(ticket, "client_aborted");
            notifyCancel("client_aborted");
            safeReject("client_aborted");
        };

        const safeReject = (reason: Reason) => {
            if (isSettled) return;
            isSettled = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            req.socket.off("close", onRuntimeClose);
            deleteParkedRelayedRequest(ticket);
            const err: any = new Error(`Relayed stream failed: ${reason}`);
            err.reason = reason;
            reject(err);
        };

        const safeResolve = (stream: Duplex) => {
            if (isSettled) return;
            isSettled = true;
            if (deadlineTimer) clearTimeout(deadlineTimer);
            req.socket.off("close", onRuntimeClose);
            resolve(stream);
        };

        const msRemaining = Math.max(1, deadline - Date.now());
        const deadlineTimer = setTimeout(async () => {
            await cancelTicketTombstone(ticket, "connect_timeout");
            notifyCancel("connect_timeout");
            safeReject("connect_timeout");
        }, msRemaining);
        deadlineTimer.unref();

        req.socket.once("close", onRuntimeClose);

        parkRelayedRequest(ticket, {
            resolve: safeResolve,
            reject: safeReject,
            lifelineWorker,
            reqId: req.id,
            deadline,
            timer: deadlineTimer,
        });

        const edgeTunnel = {
            id: tunnel.id,
            name: tunnel.name,
            internalHost: tunnel.internalHost,
            internalPort: tunnel.internalPort,
            metadata: tunnel.metadata || {},
        };
        const client = {
            ip: req.clientIp,
            correlationId: req.correlationId,
        };

        if (lifelineWorker === currentWorker) {
            const ws = getLocalLifeline(tunnel.edgeId!);
            if (!ws || ws.readyState !== ws.OPEN) {
                safeReject("edge_disconnected");
                return;
            }
            if (isLifelineSaturated(tunnel.edgeId!, ws)) {
                safeReject("edge_saturated");
                return;
            }
            const sent = sendConnectTunnel(
                ws,
                ticket,
                req.id,
                edgeTunnel,
                client,
                deadline,
                currentWorker,
                tunnel.edgeId!
            );
            if (!sent) {
                safeReject("connect_timeout");
            }
        } else if (clusterIpcSender) {
            clusterIpcSender({
                type: "relayed_tunnel_request",
                target: lifelineWorker,
                ticket,
                reqId: req.id,
                edgeId: tunnel.edgeId!,
                tunnel: edgeTunnel,
                client,
                deadline,
                originWorker: currentWorker,
            });
        }
    });
}

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

    const claimed = await claimTicket(ticket);
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

export function handleWardenIpc(msg: any, handle?: any): void {
    const currentWorker = logger.getWorkerIdentity();
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "relayed_tunnel_request" && msg.target === currentWorker) {
        const ws = getLocalLifeline(msg.edgeId);
        if (!ws || ws.readyState !== ws.OPEN) {
            if (clusterIpcSender) {
                clusterIpcSender({
                    type: "relayed_tunnel_failed",
                    target: msg.originWorker,
                    ticket: msg.ticket,
                    reason: "edge_disconnected",
                });
            }
            return;
        }
        if (isLifelineSaturated(msg.edgeId, ws)) {
            if (clusterIpcSender) {
                clusterIpcSender({
                    type: "relayed_tunnel_failed",
                    target: msg.originWorker,
                    ticket: msg.ticket,
                    reason: "edge_saturated",
                });
            }
            return;
        }
        const sent = sendConnectTunnel(
            ws,
            msg.ticket,
            msg.reqId,
            msg.tunnel,
            msg.client,
            msg.deadline,
            msg.originWorker,
            msg.edgeId
        );
        if (!sent && clusterIpcSender) {
            clusterIpcSender({
                type: "relayed_tunnel_failed",
                target: msg.originWorker,
                ticket: msg.ticket,
                reason: "connect_timeout",
            });
        }
    } else if (msg.type === "relayed_tunnel_cancel" && msg.target === currentWorker) {
        const ws = getLocalLifeline(msg.edgeId || "");
        if (ws) {
            sendCancelTunnel(ws, msg.ticket, msg.reqId || "", msg.reason);
        } else {
            deletePendingOrder(msg.ticket);
        }
    } else if (msg.type === "relayed_tunnel_failed" && msg.target === currentWorker) {
        failRelayedRequest(msg.ticket, msg.reason);
    } else if (msg.type === "relayed_tunnel_handoff" && msg.target === currentWorker) {
        deletePendingOrder(msg.ticket);
    } else if (msg.type === "relayed_tunnel_socket" && msg.target === currentWorker) {
        if (handle) {
            handleMigratedSocket(msg.ticket, Buffer.from(msg.head), msg.headers, handle);
        }
    } else if (msg.type === "close_lifeline" && msg.target === currentWorker) {
        closeLifelineLocally(msg.edgeId, msg.reason);
    }
}
