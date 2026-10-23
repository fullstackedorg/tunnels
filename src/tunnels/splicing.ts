import type { Duplex } from "node:stream";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import { isReason, type Reason } from "../constants.ts";
import { runAwaitedHook, dispatchTelemetry } from "../utils/hooks.ts";
import { getPeerCloseReason } from "../utils/ws-stream.ts";
import type { MuxStream } from "../mux/session.ts";

export interface SpliceOptions {
    /** The runtime's stream on its multiplexed session. */
    stream: MuxStream;
    targetStream: Duplex;
    req: IncomingMessageWithDeny;
    tunnel: Tunnel;
}

export type SessionTeardown = (reason: Reason, error?: Error) => void;

/**
 * Splices an established stream to its target and returns its idempotent teardown. Data flows
 * only after the tunnel_connected hook settles, so hooks observe every byte. Either side ending
 * ends both: the runtime's FIN or RESET (client_close / its reason), the target's end
 * (target_close, or the Edge's close reason for a relayed target).
 */
export function spliceTunnelStreams(options: SpliceOptions): SessionTeardown {
    const { stream, targetStream, req, tunnel } = options;

    let closed = false;
    const teardown: SessionTeardown = (reason, error) => {
        if (closed) return;
        closed = true;
        if (!stream.destroyed) {
            stream.closeReason = reason;
            stream.destroy();
        }
        if (!targetStream.destroyed) targetStream.destroy();
        dispatchTelemetry("tunnel_end", req, tunnel, reason, error);
    };

    const targetEndReason = (): Reason => {
        const peer = getPeerCloseReason(targetStream);
        return isReason(peer) ? peer : "target_close";
    };
    const runtimeEndReason = (): Reason => {
        const peer = stream.peerCloseReason;
        return isReason(peer) ? peer : "client_close";
    };

    // A burst of small DATA frames (a driver's back-to-back writes) reaches the target in one write.
    let corked = false;
    stream.prependListener("data", () => {
        if (corked) return;
        corked = true;
        targetStream.cork();
        process.nextTick(() => {
            corked = false;
            targetStream.uncork();
        });
    });

    // The runtime finished sending (FIN): the target gets the last bytes, then both close.
    stream.once("end", () => {
        if (closed) return;
        targetStream.end(() => teardown(runtimeEndReason()));
    });
    stream.once("close", () => teardown(runtimeEndReason()));
    stream.on("error", (err) => teardown("stream_error", err));

    // The target finished: the runtime gets the last bytes and FIN, then both close.
    targetStream.once("end", () => {
        if (closed) return;
        stream.end(() => teardown(targetEndReason()));
    });
    targetStream.once("close", () => teardown(targetEndReason()));
    targetStream.on("error", (err) => teardown("stream_error", err));

    void runAwaitedHook("tunnel_connected", req, tunnel, stream, targetStream).then(() => {
        if (closed) return;
        stream.pipe(targetStream, { end: false });
        targetStream.pipe(stream, { end: false });
    });

    return teardown;
}
