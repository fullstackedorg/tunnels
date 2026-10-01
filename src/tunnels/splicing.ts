import { pipeline } from "node:stream";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import { isReason, type Reason } from "../constants.ts";
import { unregisterSession } from "./registry.ts";
import { runAwaitedHook, dispatchTelemetry } from "../utils/hooks.ts";
import { getPeerCloseReason, performSymmetricalTeardown } from "../utils/ws-stream.ts";
import { getLocalCloseReason } from "../ws/heartbeat.ts";

export interface SpliceOptions {
    sessionId: string;
    runtimeWs: WebSocket;
    runtimeDuplex: Duplex;
    targetStream: Duplex;
    req: IncomingMessageWithDeny;
    tunnel: Tunnel;
}

export type SessionTeardown = (reason: Reason, error?: Error) => void;

/**
 * Splices an established session and returns its idempotent teardown. Streams are resumed
 * only after the tunnel_connected hook settles, so hooks observe every byte.
 */
export function spliceTunnelStreams(options: SpliceOptions): SessionTeardown {
    const { sessionId, runtimeWs, runtimeDuplex, targetStream, req, tunnel } = options;

    let closed = false;
    const teardown: SessionTeardown = (reason, error) => {
        if (closed) return;
        closed = true;
        (runtimeDuplex as any)._closeReason = reason;
        unregisterSession(sessionId);
        performSymmetricalTeardown({
            ws: runtimeWs,
            duplex: runtimeDuplex,
            destinationStream: targetStream,
            reason,
            error,
        });
        dispatchTelemetry("tunnel_end", req, tunnel, reason, error);
    };

    // A relayed target carries the Edge's close reason (e.g. target_unreachable after handoff).
    const targetEndReason = (): Reason => {
        const peer = getPeerCloseReason(targetStream);
        return isReason(peer) ? peer : "target_close";
    };
    targetStream.prependOnceListener("end", () => {
        (runtimeDuplex as any)._closeReason = targetEndReason();
    });

    pipeline(runtimeDuplex, targetStream, (err) => {
        teardown(err ? "stream_error" : "client_close", err ?? undefined);
    });
    pipeline(targetStream, runtimeDuplex, (err) => {
        teardown(err ? "stream_error" : targetEndReason(), err ?? undefined);
    });
    targetStream.once("error", (err) => teardown("stream_error", err));
    runtimeWs.once("close", (_code, reasonBuf) => {
        const peer = reasonBuf?.toString("utf-8");
        teardown(getLocalCloseReason(runtimeWs) ?? (isReason(peer) ? peer : "client_close"));
    });

    void runAwaitedHook("tunnel_connected", req, tunnel, runtimeDuplex, targetStream).then(() => {
        if (closed) return;
        runtimeDuplex.resume();
        targetStream.resume();
    });

    return teardown;
}
