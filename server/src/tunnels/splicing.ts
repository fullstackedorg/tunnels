import { pipeline } from "node:stream";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import type { Reason } from "../constants.ts";
import { CLOSE_CODES } from "../constants.ts";
import { unregisterSession } from "./registry.ts";
import { runAwaitedHook, dispatchTelemetry } from "../utils/hooks.ts";

export interface SpliceOptions {
    sessionId: string;
    runtimeWs: WebSocket;
    runtimeDuplex: Duplex;
    targetStream: Duplex;
    req: IncomingMessageWithDeny;
    tunnel: Tunnel;
}

export async function spliceTunnelStreams(options: SpliceOptions): Promise<void> {
    const { sessionId, runtimeWs, runtimeDuplex, targetStream, req, tunnel } = options;

    let closed = false;
    const teardown = (reason: Reason, error?: Error) => {
        if (closed) return;
        closed = true;
        (runtimeDuplex as any)._closeReason = reason;

        const code = CLOSE_CODES[reason] ?? 1000;

        if (runtimeWs.readyState === runtimeWs.OPEN) {
            try {
                runtimeWs.close(code, reason);
            } catch {}

            const cleanup = () => {
                if (!runtimeDuplex.destroyed) runtimeDuplex.destroy(error);
                if (!targetStream.destroyed) targetStream.destroy(error);
            };
            const timer = setTimeout(cleanup, 500);
            runtimeWs.once("close", () => {
                clearTimeout(timer);
                cleanup();
            });
        } else {
            if (!runtimeDuplex.destroyed) runtimeDuplex.destroy(error);
            if (!targetStream.destroyed) targetStream.destroy(error);
        }

        unregisterSession(sessionId);
        dispatchTelemetry("tunnel_end", req, tunnel, reason, error);
    };

    // Attach stream pipelines
    pipeline(runtimeDuplex, targetStream, (err) => {
        teardown(err ? "stream_error" : "client_close", err ?? undefined);
    });

    pipeline(targetStream, runtimeDuplex, (err) => {
        teardown(err ? "stream_error" : "target_close", err ?? undefined);
    });

    targetStream.once("error", (err) => {
        (runtimeDuplex as any)._closeReason = "stream_error";
        teardown("stream_error", err);
    });

    runtimeWs.once("close", (_code, reasonBuf) => {
        const reasonStr = reasonBuf ? reasonBuf.toString("utf-8") : "";
        teardown((reasonStr as Reason) || "client_close");
    });

    // Await connected telemetry hook before resuming streams
    await runAwaitedHook("tunnel_connected", req, tunnel, runtimeDuplex, targetStream);

    runtimeDuplex.resume();
    targetStream.resume();
}
