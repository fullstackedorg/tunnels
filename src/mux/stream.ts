import { Duplex } from "node:stream";
import {
    FRAME_DATA,
    FRAME_FIN,
    FRAME_OPENED,
    FRAME_RESET,
    MAX_DATA_PAYLOAD,
    STREAM_WINDOW,
    encodeFrame,
    encodeWindow,
} from "./frames.ts";

/** What a stream needs from its session. */
export interface StreamTransport {
    send(frame: Buffer): void;
    /** Resolves once the WebSocket buffer drains below its high-water mark. */
    whenWritable(): Promise<void>;
    release(id: number): void;
    readonly open: boolean;
}

/**
 * One multiplexed stream as a Node Duplex: writes become DATA frames within the peer's credit,
 * received bytes are pushed and credit is returned as the consumer reads them. `end()` sends FIN;
 * `destroy()` before both FINs sends RESET with `closeReason` (or stream_error / client_close).
 */
export class MuxStream extends Duplex {
    readonly id: number;
    /** Reason to send with RESET, and to report locally, when this side ends the stream. */
    closeReason?: string;
    /** Reason received in the peer's RESET. */
    peerCloseReason?: string;

    private readonly transport: StreamTransport;
    private sendCredit = STREAM_WINDOW;
    private creditWaiters: (() => void)[] = [];
    private received = 0;
    private granted = STREAM_WINDOW;
    private finSent = false;
    private finReceived = false;
    private resetDone = false;

    constructor(transport: StreamTransport, id: number) {
        super({ allowHalfOpen: true });
        this.transport = transport;
        this.id = id;
    }

    /** Hub side: the target is dialed. */
    opened(): void {
        this.transport.send(encodeFrame(FRAME_OPENED, this.id));
    }

    handleData(payload: Buffer): void {
        if (this.destroyed || this.finReceived) return;
        this.received += payload.length;
        this.push(payload);
        this.grantCredit();
    }

    handleWindow(increment: number): void {
        this.sendCredit += increment;
        const waiters = this.creditWaiters;
        this.creditWaiters = [];
        waiters.forEach((resolve) => resolve());
    }

    handleFin(): void {
        if (this.finReceived) return;
        this.finReceived = true;
        this.push(null);
        if (this.finSent) this.release();
    }

    handleReset(reason: string): void {
        this.resetDone = true;
        this.peerCloseReason = reason || undefined;
        const waiters = this.creditWaiters;
        this.creditWaiters = [];
        waiters.forEach((resolve) => resolve());
        this.destroy();
    }

    /** The session is gone: end without sending anything. */
    sessionClosed(reason: string): void {
        this.resetDone = true;
        if (!this.peerCloseReason) this.peerCloseReason = reason;
        this.handleWindow(0);
        this.destroy();
    }

    override _read(): void {
        this.grantCredit();
    }

    // Keep the peer's window at STREAM_WINDOW beyond what the consumer has read.
    private grantCredit(): void {
        if (this.destroyed || this.finReceived) return;
        const consumed = this.received - this.readableLength;
        const target = consumed + STREAM_WINDOW;
        if (target - this.granted >= STREAM_WINDOW / 2 && this.transport.open) {
            this.transport.send(encodeWindow(this.id, target - this.granted));
            this.granted = target;
        }
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (err?: Error) => void) {
        this.writeChunk(chunk).then(() => callback(), callback);
    }

    private async writeChunk(chunk: Buffer): Promise<void> {
        let offset = 0;
        while (offset < chunk.length) {
            if (this.resetDone || !this.transport.open) throw new Error("stream closed");
            if (this.sendCredit <= 0) {
                await new Promise<void>((resolve) => this.creditWaiters.push(resolve));
                continue;
            }
            await this.transport.whenWritable();
            const size = Math.min(MAX_DATA_PAYLOAD, this.sendCredit, chunk.length - offset);
            this.transport.send(
                encodeFrame(FRAME_DATA, this.id, chunk.subarray(offset, offset + size))
            );
            this.sendCredit -= size;
            offset += size;
        }
    }

    override _final(callback: (err?: Error) => void): void {
        if (!this.resetDone && this.transport.open) {
            this.finSent = true;
            this.transport.send(encodeFrame(FRAME_FIN, this.id));
            if (this.finReceived) this.release();
        }
        callback();
    }

    override _destroy(err: Error | null, callback: (err?: Error | null) => void): void {
        if (!this.resetDone && !(this.finSent && this.finReceived) && this.transport.open) {
            const reason = this.closeReason ?? (err ? "stream_error" : "client_close");
            this.transport.send(encodeFrame(FRAME_RESET, this.id, reason));
        }
        this.resetDone = true;
        this.release();
        callback(err);
    }

    private release(): void {
        this.transport.release(this.id);
    }
}
