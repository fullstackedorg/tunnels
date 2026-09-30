import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import type { Reason } from "../constants.ts";
import { CLOSE_CODES, DEFAULT_CONNECT_TIMEOUT } from "../constants.ts";
import { runGatingHook, dispatchTelemetry } from "../utils/hooks.ts";
import { createWebSocketServer } from "../ws/index.ts";
import { createWsDuplex } from "../utils/ws-stream.ts";
import { registerHeartbeat } from "../ws/heartbeat.ts";
import { registerSession, unregisterSession, severSessions } from "./registry.ts";
import { connectDirectTarget } from "./direct.ts";
import { spliceTunnelStreams } from "./splicing.ts";
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
    wss.handleUpgrade(req, socket, head, async (ws) => {
        registerHeartbeat(ws);
        const runtimeDuplex = createWsDuplex(ws);
        runtimeDuplex.on("error", () => {});
        runtimeDuplex.pause();

        const deadline = Date.now() + defaultConnectTimeoutSec * 1000;
        const sessionId = crypto.randomUUID();

        // Relayed edge checks
        if (tunnel.edgeId) {
            const online = await isEdgeOnline(tunnel.edgeId);
            if (!online) {
                ws.close(CLOSE_CODES.edge_disconnected, "edge_disconnected");
                return;
            }
        }

        const unregister = registerSession({
            id: sessionId,
            tunnelId: tunnel.id,
            edgeId: tunnel.edgeId,
            close: (code, reason) => {
                try {
                    ws.close(code, reason);
                } catch {}
                runtimeDuplex.destroy();
                dispatchTelemetry("tunnel_end", req, tunnel, reason);
            },
        });

        dispatchTelemetry("tunnel_start", req, tunnel);

        let targetStream: Duplex;
        try {
            if (tunnel.edgeId) {
                targetStream = await acquireRelayedStream(tunnel, req, deadline);
            } else {
                targetStream = await connectDirectTarget(
                    tunnel.internalHost,
                    tunnel.internalPort,
                    deadline
                );
            }
        } catch (err: any) {
            unregister();
            const reason: Reason = err?.reason || "connect_timeout";
            const code = CLOSE_CODES[reason] ?? 1014;

            try {
                ws.close(code, reason);
            } catch {}
            runtimeDuplex.destroy();
            dispatchTelemetry("tunnel_end", req, tunnel, reason, err);
            return;
        }

        await spliceTunnelStreams({
            sessionId,
            runtimeWs: ws,
            runtimeDuplex,
            targetStream,
            req,
            tunnel,
        });
    });
}
