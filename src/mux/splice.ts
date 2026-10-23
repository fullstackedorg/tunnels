import type { Duplex } from "node:stream";
import { isReason, type Reason } from "../constants.ts";
import { MuxStream } from "./stream.ts";

export type SpliceTeardown = (reason: Reason, error?: Error) => void;

export interface SpliceOptions {
    /** The stream that came in on a session (the runtime's on the Hub, the Hub's on the Edge). */
    stream: MuxStream;
    /** The next hop: a target socket, or a stream of a relay session. */
    other: Duplex;
    /** Reason when the stream's peer ends cleanly (FIN) or with a reason outside the taxonomy. */
    streamEnd: Reason;
    /** Reason when the other side ends cleanly. */
    otherEnd: Reason;
    /** Data flows once this settles (connected hooks observe every byte). */
    ready: Promise<unknown>;
    /** Called once, with the reason both sides ended for. */
    onEnd: SpliceTeardown;
}

const peerReason = (duplex: Duplex): string | undefined =>
    duplex instanceof MuxStream ? duplex.peerCloseReason : undefined;

/**
 * Splices a stream to the next hop, both ways, and returns its idempotent teardown. Either side
 * ending ends both: a FIN carries the last bytes over, then both close; a RESET carries its
 * reason. Mux streams are reset with the teardown's reason, so it reaches the far end.
 */
export function spliceStreams(options: SpliceOptions): SpliceTeardown {
    const { stream, other, streamEnd, otherEnd, ready, onEnd } = options;

    let closed = false;
    const teardown: SpliceTeardown = (reason, error) => {
        if (closed) return;
        closed = true;
        for (const side of [stream, other]) {
            if (side.destroyed) continue;
            if (side instanceof MuxStream) side.closeReason = reason;
            side.destroy();
        }
        onEnd(reason, error);
    };

    const endReason = (side: Duplex, clean: Reason): Reason => {
        const peer = peerReason(side);
        return isReason(peer) ? peer : clean;
    };

    // A burst of small DATA frames (a driver's back-to-back writes) reaches the next hop in one write.
    let corked = false;
    stream.prependListener("data", () => {
        if (corked) return;
        corked = true;
        other.cork();
        process.nextTick(() => {
            corked = false;
            other.uncork();
        });
    });

    stream.once("end", () => {
        if (closed) return;
        other.end(() => teardown(endReason(stream, streamEnd)));
    });
    stream.once("close", () => teardown(endReason(stream, streamEnd)));
    stream.on("error", (err) => teardown("stream_error", err));

    other.once("end", () => {
        if (closed) return;
        stream.end(() => teardown(endReason(other, otherEnd)));
    });
    other.once("close", () => teardown(endReason(other, otherEnd)));
    other.on("error", (err) => teardown("stream_error", err));

    // A side that already closed (it raced the setup) ends both now: its close event is gone.
    if (stream.destroyed || other.destroyed) {
        const side = stream.destroyed ? stream : other;
        queueMicrotask(() => teardown(endReason(side, side === stream ? streamEnd : otherEnd)));
    }

    void ready.then(() => {
        if (closed) return;
        stream.pipe(other, { end: false });
        other.pipe(stream, { end: false });
    });

    return teardown;
}
