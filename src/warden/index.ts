import type { Duplex } from "node:stream";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import type { Reason } from "../constants.ts";
import { logger } from "../utils/logger.ts";
import { kv } from "../kv/index.ts";
import { DEFAULT_CONNECT_TIMEOUT } from "../constants.ts";
import { createTicket, cancelTicketTombstone } from "./tickets.ts";
import {
    isLifelineSaturated,
    sendConnectTunnel,
    sendCancelTunnel,
    deletePendingOrder,
    getPendingOrder,
} from "./orders.ts";
import {
    getLocalLifeline,
    isEdgeOnline,
    wardenLifeline,
    closeLifelineLocally,
    closeAllLifelines,
    cancelLocalPendingOrders,
    setClusterIpcSender as setLifelineClusterIpc,
    setFailRelayedRequestFn,
    setPresenceHeartbeatTimeout,
} from "./lifeline.ts";
import {
    parkRelayedRequest,
    deleteParkedRelayedRequest,
    failRelayedRequest,
    failAllParkedRequests,
    handleMigratedSocket,
    setMigrationIpcSender,
} from "./migration.ts";

export {
    isEdgeOnline,
    wardenLifeline,
    closeLifelineLocally,
    closeLifeline,
    setWardenBootId,
} from "./lifeline.ts";
export { handleMigratedSocket, wardenRelayedSocket } from "./migration.ts";

setFailRelayedRequestFn(failRelayedRequest);

let clusterIpcSender: ((msg: any, handle?: any) => void) | null = null;
let connectTimeoutSec = DEFAULT_CONNECT_TIMEOUT;

/** Applies the Hub settings the Warden depends on. */
export function configureWarden(options: { connectTimeout: number; heartbeatTimeout: number }) {
    connectTimeoutSec = options.connectTimeout;
    setPresenceHeartbeatTimeout(options.heartbeatTimeout);
}

/** Hub shutdown: cancel orders on local lifelines, fail parked requests, close lifelines. */
export async function shutdownWarden(reason: Reason = "hub_shutdown"): Promise<void> {
    cancelLocalPendingOrders(reason);
    failAllParkedRequests(reason);
    await closeAllLifelines(reason);
}

function kvFailure(err: unknown): Error {
    const wrapped: any = new Error(`KV unavailable during relayed setup: ${(err as any)?.message}`);
    wrapped.reason = "stream_error";
    return wrapped;
}

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
    let lifelineWorker: string | null;
    try {
        lifelineWorker = await kv.get<string>(`edge:${tunnel.edgeId}:worker`);
    } catch (err) {
        throw kvFailure(err);
    }
    if (!lifelineWorker) {
        const err: any = new Error("Edge is offline");
        err.reason = "edge_disconnected";
        throw err;
    }

    let ticket: string;
    try {
        ticket = await createTicket(
            currentWorker,
            lifelineWorker,
            tunnel.edgeId,
            req.id,
            tunnel.id,
            connectTimeoutSec + 2
        );
    } catch (err) {
        throw kvFailure(err);
    }

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

        const abandon = (reason: Reason) => {
            if (isSettled) return;
            safeReject(reason);
            notifyCancel(reason);
            cancelTicketTombstone(ticket, reason).catch((err) => {
                logger.warn("Warden", `Failed to write ticket tombstone: ${err?.message}`);
            });
        };
        const onRuntimeClose = () => abandon("client_aborted");

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
        const deadlineTimer = setTimeout(() => abandon("connect_timeout"), msRemaining);
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
        const pending = getPendingOrder(msg.ticket);
        const ws = pending ? getLocalLifeline(pending.edgeId) : undefined;
        if (pending && ws) {
            sendCancelTunnel(ws, msg.ticket, pending.reqId, msg.reason);
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
