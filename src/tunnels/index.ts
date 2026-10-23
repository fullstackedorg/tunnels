import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import { CLOSE_CODES, DEFAULT_CONNECT_TIMEOUT, isReason, type Reason } from "../constants.ts";
import { runGatingHook, dispatchTelemetry } from "../utils/hooks.ts";
import { logger } from "../utils/logger.ts";
import { createWebSocketServer } from "../ws/index.ts";
import { closeWithReason, getLocalCloseReason, registerHeartbeat } from "../ws/heartbeat.ts";
import { MuxSession, type MuxStream } from "../mux/session.ts";
import { registerSession, severedSince, unregisterSession } from "./registry.ts";
import { connectDirectTarget } from "./direct.ts";
import { spliceTunnelStreams } from "./splicing.ts";
import { openRelayedStream, isEdgeOnline } from "../warden/index.ts";

export { severSessions } from "./registry.ts";

let defaultConnectTimeoutSec = DEFAULT_CONNECT_TIMEOUT;

/** Most streams one runtime session carries at once (the runtime opens more sessions first). */
const MAX_STREAMS_PER_SESSION = 256;

export function setTunnelConnectTimeout(seconds: number): void {
    defaultConnectTimeoutSec = seconds;
}

/**
 * A runtime's tunnel WebSocket is a multiplexed session (src/mux): authenticated and gated once
 * at the upgrade, then every stream it opens is one connection to the tunnel's target, with its
 * own tunnel_start / tunnel_connected / tunnel_end hooks and its own request id.
 */
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
        try {
            runMuxSession(req, ws, tunnel);
        } catch (err) {
            logger.error("Tunnel", "Session setup failed", { reqId: req.id, error: err });
            closeWithReason(ws, "stream_error");
        }
    });
}

function runMuxSession(req: IncomingMessageWithDeny, ws: WebSocket, tunnel: Tunnel): void {
    registerHeartbeat(ws);
    // the tunnel or its Edge was severed while this upgrade was set up from its old state
    const severed = severedSince(req.resolvedAt, { tunnelId: tunnel.id, edgeId: tunnel.edgeId });
    if (severed) {
        closeWithReason(ws, severed);
        return;
    }
    const sessionId = crypto.randomUUID();

    const session = new MuxSession(ws, {
        maxStreams: MAX_STREAMS_PER_SESSION,
        onOpen: (stream) => {
            runStream(req, stream, tunnel).catch((err) => {
                logger.error("Tunnel", "Stream setup failed", { reqId: req.id, error: err });
                stream.closeReason = "stream_error";
                stream.destroy();
            });
        },
    });

    // A close this side decided (heartbeat, sever) carries its own reason to every stream.
    ws.prependOnceListener("close", (_code: number, reasonBuf: Buffer) => {
        unregisterSession(sessionId);
        const peer = reasonBuf?.toString("utf-8");
        session.end(getLocalCloseReason(ws) ?? (isReason(peer) ? peer : "client_close"));
    });

    registerSession({
        id: sessionId,
        tunnelId: tunnel.id,
        edgeId: tunnel.edgeId,
        close: (_code, reason) => {
            session.end(reason);
            try {
                ws.close(CLOSE_CODES[reason] ?? 1000, reason);
            } catch {
                ws.terminate();
            }
        },
    });
}

/** The request a stream's hooks see: the session's, with its own id and own plain-object fields. */
function streamRequest(req: IncomingMessageWithDeny, streamId: number): IncomingMessageWithDeny {
    const streamReq = Object.create(req);
    for (const [key, value] of Object.entries(req)) {
        if (
            value &&
            typeof value === "object" &&
            Object.getPrototypeOf(value) === Object.prototype
        ) {
            streamReq[key] = { ...value };
        }
    }
    streamReq.id = `${req.id}.${streamId}`;
    streamReq.muxStreamId = streamId;
    streamReq.openedAt = performance.now();
    return streamReq;
}

async function edgeIsOnline(edgeId: string): Promise<boolean | null> {
    try {
        return await isEdgeOnline(edgeId);
    } catch {
        return null; // KV unavailable
    }
}

async function runStream(sessionReq: IncomingMessageWithDeny, stream: MuxStream, tunnel: Tunnel) {
    const req = streamRequest(sessionReq, stream.id);
    stream.pause();
    stream.on("error", () => {});

    const deadline = Date.now() + defaultConnectTimeoutSec * 1000;

    // Liveness (relayed only): no stream starts for an offline Edge.
    if (tunnel.edgeId) {
        const online = await edgeIsOnline(tunnel.edgeId);
        if (online !== true) {
            stream.closeReason = online === null ? "stream_error" : "edge_disconnected";
            stream.destroy();
            return;
        }
    }

    const abortDial = new AbortController();
    let ended = false;

    // Ends a stream whose target is not spliced yet. Idempotent.
    const endBeforeSplice = (reason: Reason, error?: Error) => {
        if (ended) return;
        ended = true;
        abortDial.abort(reason);
        if (!stream.destroyed) {
            stream.closeReason = reason;
            stream.destroy();
        }
        dispatchTelemetry("tunnel_end", req, tunnel, reason, error);
    };

    dispatchTelemetry("tunnel_start", req, tunnel);

    const onEarlyClose = () => {
        const peer = stream.peerCloseReason;
        endBeforeSplice(isReason(peer) && peer !== "client_close" ? peer : "client_aborted");
    };
    stream.once("close", onEarlyClose);

    let targetStream: Duplex;
    try {
        targetStream = tunnel.edgeId
            ? await openRelayedStream(tunnel, req, deadline, abortDial.signal)
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
        stream.off("close", onEarlyClose);
    }

    if (ended) {
        // Severed or closed while the target stream was being established.
        targetStream.destroy();
        return;
    }

    stream.opened();
    spliceTunnelStreams({ stream, targetStream, req, tunnel });
}
