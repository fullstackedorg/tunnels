import type { WebSocket } from "ws";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Edge } from "../entities/schema.ts";
import { isReason, type Reason } from "../constants.ts";
import { kv } from "../kv/index.ts";
import { storage } from "../storage/index.ts";
import { logger } from "../utils/logger.ts";
import { runGatingHook, dispatchTelemetry } from "../utils/hooks.ts";
import { closeWithReason, getLocalCloseReason, registerHeartbeat } from "../ws/heartbeat.ts";
import { createWebSocketServer } from "../ws/index.ts";
import { liveRelays, relayRequestFailed, requestRelay } from "./relays.ts";
import type { OpenRelayOrder } from "./types.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT } from "../constants.ts";

const edgeLifelines = new Map<string, WebSocket>();
let clusterIpcSender: ((msg: any) => void) | null = null;
let currentBootId = "1";
let presenceTtlSec = 2 * DEFAULT_HEARTBEAT_TIMEOUT;

/** Presence (`edge:<id>:worker`) lives for 2 * HEARTBEAT_TIMEOUT. */
export function setPresenceHeartbeatTimeout(heartbeatTimeoutSec: number): void {
    presenceTtlSec = 2 * heartbeatTimeoutSec;
}

export function setClusterIpcSender(sender: ((msg: any) => void) | null): void {
    clusterIpcSender = sender;
}

export function setWardenBootId(bootId: string): void {
    currentBootId = bootId;
}

export function getLocalLifeline(edgeId: string): WebSocket | undefined {
    return edgeLifelines.get(edgeId);
}

/** Orders the Edge to dial a relay session to `worker`; false without an open local lifeline. */
export function sendOpenRelay(edgeId: string, worker: string): boolean {
    const ws = edgeLifelines.get(edgeId);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    const order: OpenRelayOrder = { type: "open_relay", worker };
    try {
        ws.send(JSON.stringify(order));
        return true;
    } catch {
        return false;
    }
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
    const ttl30Days = 30 * 24 * 3600;

    await kv.set(`edge:${edgeId}:worker`, workerId, presenceTtlSec);
    await kv.set(`edge:${edgeId}:last_seen`, nowSec, ttl30Days);
    await kv.sadd(`worker:${workerId}:edges`, edgeId);
}

export async function closeLifelineLocally(
    edgeId: string,
    reason: Reason = "superseded"
): Promise<void> {
    const existing = edgeLifelines.get(edgeId);
    if (existing) closeWithReason(existing, reason);
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
    for (const ws of edgeLifelines.values()) closeWithReason(ws, reason);
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
    wss.handleUpgrade(req, socket, head, (ws) => {
        // A KV failure here (Redis down) closes this lifeline: the Edge dials again
        acceptLifeline(req, ws, edge).catch((err) => {
            logger.error("Warden", `Lifeline setup of edge ${edge.id} failed`, { error: err });
            if (edgeLifelines.get(edge.id) === ws) edgeLifelines.delete(edge.id);
            closeWithReason(ws, "stream_error");
        });
    });
}

async function acceptLifeline(req: IncomingMessageWithDeny, ws: WebSocket, edge: Edge) {
    const workerId = logger.getWorkerIdentity();
    // first, so its "error" listener is there before anything is awaited
    registerHeartbeat(ws, {
        onSweep: () => {
            refreshPresence(edge.id).catch(() => {});
        },
    });

    // 1. Supersede existing lifeline
    const existing = edgeLifelines.get(edge.id);
    if (existing) {
        closeWithReason(existing, "superseded");
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
    await refreshPresence(edge.id).catch((err) => {
        logger.warn("Warden", `Failed to write presence of edge ${edge.id}: ${err?.message}`);
    });

    // 4. A relay session kept warm here, so the first stream skips the Edge's dial (asked on
    // this lifeline even when an earlier one was asked already)
    if (!liveRelays(edge.id).length) requestRelay(edge.id, true);

    // 5. The Edge reports relay sessions it could not dial
    ws.on("message", (data: Buffer | string) => {
        try {
            const text = typeof data === "string" ? data : data.toString("utf-8");
            const msg = JSON.parse(text);
            if (msg?.type !== "open_relay_failed" || typeof msg.worker !== "string") return;
            if (msg.worker === workerId) {
                relayRequestFailed(edge.id);
            } else if (clusterIpcSender) {
                clusterIpcSender({ type: "relay_failed", target: msg.worker, edgeId: edge.id });
            }
        } catch (err) {
            logger.warn("Warden", `Malformed lifeline frame: ${(err as any)?.message}`);
        }
    });

    // 6. Cleanup on disconnect
    ws.once("close", (_code, reasonBuf) => {
        const peerReason = reasonBuf?.toString("utf-8");
        const reason: Reason =
            getLocalCloseReason(ws) ?? (isReason(peerReason) ? peerReason : "client_close");
        onLifelineClosed(edge, ws, workerId, reason).catch((err) => {
            logger.warn("Warden", `Lifeline cleanup failed: ${err?.message}`);
        });
    });
}

async function onLifelineClosed(edge: Edge, ws: WebSocket, workerId: string, reason: Reason) {
    // A newer lifeline for this Edge on this worker keeps its registration and presence.
    const replaced = edgeLifelines.has(edge.id) && edgeLifelines.get(edge.id) !== ws;
    if (!replaced) {
        edgeLifelines.delete(edge.id);
        // no relay session will be dialed on its behalf any more
        relayRequestFailed(edge.id, reason === "hub_shutdown" ? reason : "edge_disconnected");
        try {
            await kv.delIfEquals(`edge:${edge.id}:worker`, workerId);
            await kv.srem(`worker:${workerId}:edges`, edge.id);
        } catch (err: any) {
            logger.warn("Warden", `Failed to clear presence of edge ${edge.id}: ${err?.message}`);
        }
    }

    dispatchTelemetry("lifeline_disconnect", null, edge, reason);
}
