import type { WebSocket, RawData } from "ws";
import {
    FRAME_DATA,
    FRAME_FIN,
    FRAME_OPEN,
    FRAME_OPENED,
    FRAME_RESET,
    FRAME_WINDOW,
    decodeFrame,
    encodeFrame,
} from "./frames.ts";
import { MuxStream, type StreamTransport } from "./stream.ts";

export { MuxStream } from "./stream.ts";

/** WebSocket bytes buffered beyond which stream writes wait for the socket to drain. */
const WS_HIGH_WATER = 1024 * 1024;

export interface MuxSessionOptions {
    /** Accepting side: a peer opened stream `stream` with `payload`. */
    onOpen?: (stream: MuxStream, payload: Buffer) => void;
    /** Most streams open at once; an OPEN beyond it is answered with RESET `stream_limit`. */
    maxStreams?: number;
    /** The reason streams end with when the WebSocket closes (default: the peer's, else client_close). */
    endReason?: (peerReason: string) => string;
}

/**
 * Many streams over one WebSocket (see frames.ts). Either side can accept (onOpen) or open
 * (openStream); ids are picked by the opener. Closing the WebSocket ends every stream with the
 * close reason.
 */
export class MuxSession implements StreamTransport {
    readonly ws: WebSocket;
    private readonly streams = new Map<number, MuxStream>();
    private readonly pending = new Map<
        number,
        { resolve: () => void; reject: (e: Error) => void }
    >();
    private readonly options: MuxSessionOptions;
    private nextId = 1;
    private drainWaiters: (() => void)[] = [];
    private drainTimer: NodeJS.Timeout | null = null;
    private closedReason: string | null = null;

    constructor(ws: WebSocket, options: MuxSessionOptions = {}) {
        this.ws = ws;
        this.options = options;
        ws.on("message", (data: RawData, isBinary: boolean) => {
            if (isBinary) this.handleMessage(data as Buffer);
        });
        ws.once("close", (_code: number, reasonBuf: Buffer) => {
            const peer = reasonBuf?.toString("utf-8") || "";
            this.end(options.endReason ? options.endReason(peer) : peer || "client_close");
        });
    }

    get open(): boolean {
        return this.closedReason === null && this.ws.readyState === this.ws.OPEN;
    }

    get size(): number {
        return this.streams.size;
    }

    send(frame: Buffer): void {
        if (this.ws.readyState === this.ws.OPEN) this.ws.send(frame, { binary: true });
    }

    whenWritable(): Promise<void> {
        if (this.ws.bufferedAmount < WS_HIGH_WATER || !this.open) return Promise.resolve();
        return new Promise((resolve) => {
            this.drainWaiters.push(resolve);
            this.pollDrain();
        });
    }

    // ws has no drain event for the socket buffer: poll it while writers wait.
    private pollDrain(): void {
        if (this.drainTimer) return;
        this.drainTimer = setInterval(() => {
            if (this.ws.bufferedAmount >= WS_HIGH_WATER && this.open) return;
            clearInterval(this.drainTimer!);
            this.drainTimer = null;
            const waiters = this.drainWaiters;
            this.drainWaiters = [];
            waiters.forEach((resolve) => resolve());
        }, 5);
    }

    release(id: number): void {
        this.streams.delete(id);
    }

    /**
     * Opening side: a new stream at once, its bytes may follow OPEN right away; `ready` resolves
     * when the peer answers OPENED and rejects (with `reason`) on its RESET.
     */
    startStream(payload?: Buffer | string): { stream: MuxStream; ready: Promise<void> } {
        if (!this.open) throw new Error("session closed");
        const id = this.nextId++;
        const stream = new MuxStream(this, id);
        this.streams.set(id, stream);
        const ready = new Promise<void>((resolve, reject) =>
            this.pending.set(id, { resolve, reject })
        );
        ready.catch(() => {}); // the stream's close carries the reason too
        this.send(encodeFrame(FRAME_OPEN, id, payload));
        return { stream, ready };
    }

    /** Opening side: a new stream, once the peer answered OPENED. */
    async openStream(payload?: Buffer | string): Promise<MuxStream> {
        const { stream, ready } = this.startStream(payload);
        await ready;
        return stream;
    }

    private handleMessage(message: Buffer): void {
        const frame = decodeFrame(message);
        if (!frame) return;
        const { type, id, payload } = frame;

        if (type === FRAME_OPEN) {
            if (this.streams.has(id) || !this.options.onOpen) {
                this.send(encodeFrame(FRAME_RESET, id, "stream_error"));
                return;
            }
            if (this.options.maxStreams && this.streams.size >= this.options.maxStreams) {
                this.send(encodeFrame(FRAME_RESET, id, "stream_limit"));
                return;
            }
            const stream = new MuxStream(this, id);
            this.streams.set(id, stream);
            this.options.onOpen(stream, payload);
            return;
        }

        const stream = this.streams.get(id);
        const waiter = this.pending.get(id);
        if (type === FRAME_OPENED) {
            this.pending.delete(id);
            waiter?.resolve();
            return;
        }
        if (type === FRAME_RESET && waiter) {
            this.pending.delete(id);
            const err: any = new Error(payload.toString("utf-8") || "stream_error");
            err.reason = payload.toString("utf-8") || "stream_error";
            waiter.reject(err);
        }
        if (!stream) return;
        if (type === FRAME_DATA) stream.handleData(payload);
        else if (type === FRAME_WINDOW && payload.length >= 4)
            stream.handleWindow(payload.readUInt32BE(0));
        else if (type === FRAME_FIN) stream.handleFin();
        else if (type === FRAME_RESET) stream.handleReset(payload.toString("utf-8"));
    }

    /** Ends every stream (the WebSocket closed or is being closed with `reason`). */
    end(reason: string): void {
        if (this.closedReason !== null) return;
        this.closedReason = reason;
        if (this.drainTimer) clearInterval(this.drainTimer);
        this.drainWaiters.forEach((resolve) => resolve());
        this.drainWaiters = [];
        for (const [id, waiter] of this.pending) {
            const err: any = new Error(reason);
            err.reason = reason;
            waiter.reject(err);
            this.pending.delete(id);
        }
        for (const stream of [...this.streams.values()]) stream.sessionClosed(reason);
        this.streams.clear();
    }
}
