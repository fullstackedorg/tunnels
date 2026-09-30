import type { WebSocket } from "ws";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Edge } from "../entities/schema.ts";
import type { Reason } from "../constants.ts";
import { kv } from "../kv/index.ts";
import { storage } from "../storage/index.ts";
import { logger } from "../utils/logger.ts";
import { runGatingHook, dispatchTelemetry } from "../utils/hooks.ts";
import { registerHeartbeat } from "../ws/heartbeat.ts";
import { createWebSocketServer } from "../ws/index.ts";
import { deletePendingOrder, getPendingOrdersForEdge, pruneExpiredOrders } from "./orders.ts";
import { deleteTicket } from "./tickets.ts";
import { failAllParkedRequests } from "./migration.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT } from "../constants.ts";

const edgeLifelines = new Map<string, WebSocket>();
let clusterIpcSender: ((msg: any) => void) | null = null;
let currentBootId = "1";
let failRelayedRequestFn: ((ticket: string, reason: Reason) => void) | null = null;

export function setClusterIpcSender(sender: ((msg: any) => void) | null): void {
    clusterIpcSender = sender;
}

export function setFailRelayedRequestFn(fn: (ticket: string, reason: Reason) => void): void {
    failRelayedRequestFn = fn;
}

export function setWardenBootId(bootId: string): void {
    currentBootId = bootId;
}

export function getLocalLifeline(edgeId: string): WebSocket | undefined {
    return edgeLifelines.get(edgeId);
}

export async function isEdgeOnline(edgeId: string): Promise<boolean> {
    if (edgeLifelines.has(edgeId)) {
        return true;
    }
    const workerIdentity = await kv.get<string>(`edge:${edgeId}:worker`);
    if (!workerIdentity) return false;
    const [bootId] = workerIdentity.split(":");
    return bootId === currentBootId;
}

export async function refreshPresence(edgeId: string): Promise<void> {
    const workerId = logger.getWorkerIdentity();
    const nowSec = Math.floor(Date.now() / 1000);
    const ttlWorker = 2 * DEFAULT_HEARTBEAT_TIMEOUT;
    const ttl30Days = 30 * 24 * 3600;

    await kv.set(`edge:${edgeId}:worker`, workerId, ttlWorker);
    await kv.set(`edge:${edgeId}:last_seen`, nowSec, ttl30Days);
    await kv.sadd(`worker:${workerId}:edges`, edgeId);
}

export async function closeLifelineLocally(
    edgeId: string,
    reason: Reason = "superseded"
): Promise<void> {
    const existing = edgeLifelines.get(edgeId);
    if (existing && existing.readyState === existing.OPEN) {
        const code = reason === "hub_shutdown" ? 1001 : 1000;
        try {
            existing.close(code, reason);
        } catch {}
    }
}

export async function closeLifeline(edgeId: string, reason: Reason = "superseded"): Promise<void> {
    await closeLifelineLocally(edgeId, reason);
    const workerIdentity = await kv.get<string>(`edge:${edgeId}:worker`);
    if (workerIdentity && clusterIpcSender) {
        clusterIpcSender({
            type: "close_lifeline",
            target: workerIdentity,
            edgeId,
            reason,
        });
    }
}

export async function closeAllLifelines(reason: Reason = "hub_shutdown"): Promise<void> {
    const code = reason === "hub_shutdown" ? 1001 : 1000;
    const entries = Array.from(edgeLifelines.entries());
    for (const [edgeId, ws] of entries) {
        if (ws.readyState === ws.OPEN) {
            try {
                ws.close(code, reason);
            } catch {}
        }
    }
}

export async function shutdownWarden(reason: Reason = "hub_shutdown"): Promise<void> {
    failAllParkedRequests(reason);
    await closeAllLifelines(reason);
}

export async function wardenLifeline(
    req: IncomingMessageWithDeny,
    socket: any,
    head: Buffer,
    edge: Edge
): Promise<void> {
    const passed = await runGatingHook("lifeline_connect", req, edge);
    if (!passed || req.denied) {
        return;
    }

    const wss = createWebSocketServer();
    wss.handleUpgrade(req, socket, head, async (ws) => {
        const workerId = logger.getWorkerIdentity();

        // 1. Supersede existing lifeline
        const existing = edgeLifelines.get(edge.id);
        if (existing) {
            try {
                existing.close(1000, "superseded");
            } catch {}
        } else {
            const currentWorker = await kv.get<string>(`edge:${edge.id}:worker`);
            if (currentWorker && currentWorker !== workerId && clusterIpcSender) {
                clusterIpcSender({
                    type: "close_lifeline",
                    target: currentWorker,
                    edgeId: edge.id,
                    reason: "superseded",
                });
            }
        }

        // 2. Version update if changed
        const versionHeader = req.headers["version"];
        const versionStr = Array.isArray(versionHeader) ? versionHeader[0] : versionHeader;
        if (versionStr && versionStr !== edge.version) {
            storage.update("edge", edge.id, { version: versionStr }).catch((err) => {
                logger.warn("Warden", `Failed to update edge version: ${err?.message}`);
            });
        }

        // 3. Register lifeline & presence
        edgeLifelines.set(edge.id, ws);
        await refreshPresence(edge.id);

        registerHeartbeat(ws, {
            onSweep: () => {
                pruneExpiredOrders();
                refreshPresence(edge.id).catch(() => {});
            },
        });

        // 4. Handle incoming messages on lifeline
        ws.on("message", async (data: Buffer | string) => {
            try {
                const text = typeof data === "string" ? data : data.toString("utf-8");
                const order = JSON.parse(text);
                if (order?.type === "connect_tunnel_failed" && order.ticket) {
                    await deleteTicket(order.ticket);
                    const pending = deletePendingOrder(order.ticket);
                    const reason: Reason = order.reason || "relay_dial_failed";

                    if (pending && clusterIpcSender && (pending as any).originWorker !== workerId) {
                        clusterIpcSender({
                            type: "relayed_tunnel_failed",
                            target: (pending as any).originWorker,
                            ticket: order.ticket,
                            reason,
                        });
                    } else if (failRelayedRequestFn) {
                        failRelayedRequestFn(order.ticket, reason);
                    }
                }
            } catch (err) {
                logger.warn("Warden", `Malformed lifeline frame: ${(err as any)?.message}`);
            }
        });

        // 5. Cleanup on disconnect
        ws.once("close", async (code, reasonBuf) => {
            edgeLifelines.delete(edge.id);
            const reasonStr = (reasonBuf ? reasonBuf.toString("utf-8") : "") as Reason;
            const reason: Reason = reasonStr || (code === 1001 ? "hub_shutdown" : "client_close");

            await kv.delIfEquals(`edge:${edge.id}:worker`, workerId);
            await kv.srem(`worker:${workerId}:edges`, edge.id);

            const pending = getPendingOrdersForEdge(edge.id);
            for (const { ticket, order } of pending) {
                deletePendingOrder(ticket);
                await deleteTicket(ticket);
                const failReason = reason === "hub_shutdown" ? "hub_shutdown" : "edge_disconnected";
                if (clusterIpcSender && order.originWorker !== workerId) {
                    clusterIpcSender({
                        type: "relayed_tunnel_failed",
                        target: order.originWorker,
                        ticket,
                        reason: failReason,
                    });
                } else if (failRelayedRequestFn) {
                    failRelayedRequestFn(ticket, failReason);
                }
            }

            dispatchTelemetry("lifeline_disconnect", null, edge, reason);
        });
    });
}
