import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import { DEFAULT_CONNECT_TIMEOUT, isReason, type Reason } from "../constants.ts";
import { runGatingHook, dispatchTelemetry } from "../utils/hooks.ts";
import { logger } from "../utils/logger.ts";
import { createWebSocketServer } from "../ws/index.ts";
import { createWsDuplex, performSymmetricalTeardown } from "../utils/ws-stream.ts";
import { closeWithReason, registerHeartbeat } from "../ws/heartbeat.ts";
import { registerSession, unregisterSession } from "./registry.ts";
import { connectDirectTarget } from "./direct.ts";
import { spliceTunnelStreams, type SessionTeardown } from "./splicing.ts";
import { acquireRelayedStream, isEdgeOnline } from "../warden/index.ts";

export { severSessions } from "./registry.ts";

let defaultConnectTimeoutSec = DEFAULT_CONNECT_TIMEOUT;

export function setTunnelConnectTimeout(seconds: number): void {
    defaultConnectTimeoutSec = seconds;
}

export async function handleTunnelUpgrade(
    req: IncomingMessageWithDeny,
    socket: Duplex,
    head: Buffer,
    tunnel: Tunnel
): Promise<void> {
    const passed = await runGatingHook("tunnel_request", req, tunnel);
    if (!passed || req.denied) {
        return;
    }

    const wss = createWebSocketServer();
    wss.handleUpgrade(req, socket, head, (ws) => {
        runSession(req, ws, tunnel).catch((err) => {
            logger.error("Tunnel", "Session setup failed", { reqId: req.id, error: err });
            closeWithReason(ws, "stream_error");
        });
    });
}

async function edgeIsOnline(edgeId: string): Promise<boolean | null> {
    try {
        return await isEdgeOnline(edgeId);
    } catch {
        return null; // KV unavailable
    }
}

async function runSession(req: IncomingMessageWithDeny, ws: WebSocket, tunnel: Tunnel) {
    registerHeartbeat(ws);
    const runtimeDuplex = createWsDuplex(ws);
    runtimeDuplex.on("error", () => {});
    runtimeDuplex.pause();

    const deadline = Date.now() + defaultConnectTimeoutSec * 1000;

    // Liveness (relayed only): no session starts for an offline Edge.
    if (tunnel.edgeId) {
        const online = await edgeIsOnline(tunnel.edgeId);
        if (online !== true) {
            closeWithReason(ws, online === null ? "stream_error" : "edge_disconnected");
            return;
        }
    }

    const sessionId = crypto.randomUUID();
    const abortDial = new AbortController();
    let teardown: SessionTeardown | null = null;
    let ended = false;

    // Ends a session whose target stream is not spliced yet. Idempotent.
    const endBeforeSplice = (reason: Reason, error?: Error) => {
        if (ended) return;
        ended = true;
        unregisterSession(sessionId);
        abortDial.abort(reason);
        (runtimeDuplex as any)._closeReason = reason;
        performSymmetricalTeardown({ ws, duplex: runtimeDuplex, reason, error });
        dispatchTelemetry("tunnel_end", req, tunnel, reason, error);
    };

    registerSession({
        id: sessionId,
        tunnelId: tunnel.id,
        edgeId: tunnel.edgeId,
        close: (_code, reason) => (teardown ? teardown(reason) : endBeforeSplice(reason)),
    });
    dispatchTelemetry("tunnel_start", req, tunnel);

    const onEarlyClose = () => endBeforeSplice("client_aborted");
    ws.once("close", onEarlyClose);

    let targetStream: Duplex;
    try {
        targetStream = tunnel.edgeId
            ? await acquireRelayedStream(tunnel, req, deadline)
            : await connectDirectTarget(
                  tunnel.internalHost,
                  tunnel.internalPort,
                  deadline,
                  abortDial.signal
              );
    } catch (err: any) {
        endBeforeSplice(isReason(err?.reason) ? err.reason : "stream_error", err);
        return;
    } finally {
        ws.off("close", onEarlyClose);
    }

    if (ended) {
        // Severed or shut down while the target stream was being established.
        targetStream.destroy();
        return;
    }

    teardown = spliceTunnelStreams({
        sessionId,
        runtimeWs: ws,
        runtimeDuplex,
        targetStream,
        req,
        tunnel,
    });
}
