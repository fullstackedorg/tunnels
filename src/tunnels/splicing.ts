import type { Duplex } from "node:stream";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import { runAwaitedHook, dispatchTelemetry } from "../utils/hooks.ts";
import type { MuxStream } from "../mux/session.ts";
import { spliceStreams, type SpliceTeardown } from "../mux/splice.ts";

export interface SpliceOptions {
    /** The runtime's stream on its multiplexed session. */
    stream: MuxStream;
    /** The target socket (direct) or the stream on the Edge's relay session (relayed). */
    targetStream: Duplex;
    req: IncomingMessageWithDeny;
    tunnel: Tunnel;
}

/**
 * Splices an established stream to its target and returns its idempotent teardown. Data flows
 * only after the tunnel_connected hook settles, so hooks observe every byte. Either side ending
 * ends both: the runtime's FIN or RESET (client_close / its reason), the target's end
 * (target_close, or the Edge's RESET reason for a relayed target).
 */
export function spliceTunnelStreams(options: SpliceOptions): SpliceTeardown {
    const { stream, targetStream, req, tunnel } = options;
    return spliceStreams({
        stream,
        other: targetStream,
        streamEnd: "client_close",
        otherEnd: "target_close",
        ready: runAwaitedHook("tunnel_connected", req, tunnel, stream, targetStream),
        onEnd: (reason, error) => dispatchTelemetry("tunnel_end", req, tunnel, reason, error),
    });
}
