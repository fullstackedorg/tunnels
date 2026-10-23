import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { CLOSE_CODES } from "../src/constants.ts";
import { MuxSession, type MuxStream } from "../src/mux/session.ts";

/**
 * A runtime-side tunnel connection for tests: one WebSocket to the hub carrying one multiplexed
 * stream, with the small WebSocket-like API the tests used before multiplexing: `send`,
 * `message` (Buffer), `close(code, reasonBuffer)` from the stream's end (or from the WebSocket
 * when the upgrade is refused), `close()`, `terminate()`.
 */
export class TunnelClient extends EventEmitter {
    readonly ws: WebSocket;
    readonly session: MuxSession;
    stream: MuxStream | null = null;
    private closed = false;
    private pendingWrites: Buffer[] = [];

    constructor(ws: WebSocket) {
        super();
        this.ws = ws;
        this.session = new MuxSession(ws);
        ws.on("error", () => {});
        if (ws.readyState === WebSocket.OPEN) this.start();
        else ws.once("open", () => this.start());
        // no stream yet: the upgrade was refused, report the WebSocket's close
        ws.once("close", (code: number, reason: Buffer) => {
            if (!this.stream) this.finish(code, reason.toString("utf-8"));
        });
    }

    override on(event: "message", listener: (data: Buffer) => void): this;
    override on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    override on(event: string, listener: (...args: any[]) => void): this;
    override on(event: string, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    override once(event: "message", listener: (data: Buffer) => void): this;
    override once(event: "close", listener: (code: number, reason: Buffer) => void): this;
    override once(event: string, listener: (...args: any[]) => void): this;
    override once(event: string, listener: (...args: any[]) => void): this {
        return super.once(event, listener);
    }

    private start(): void {
        const stream = this.session.startStream().stream;
        this.stream = stream;
        stream.on("data", (data: Buffer) => this.emit("message", data));
        stream.on("error", () => {});
        stream.once("close", () => {
            const reason = stream.peerCloseReason ?? "target_close";
            this.finish((CLOSE_CODES as Record<string, number>)[reason] ?? 1000, reason);
        });
        stream.once("end", () => stream.destroy());
        for (const chunk of this.pendingWrites) stream.write(chunk);
        this.pendingWrites = [];
        this.emit("open");
    }

    get readyState(): number {
        if (this.closed) return WebSocket.CLOSED;
        return this.stream ? this.ws.readyState : WebSocket.CONNECTING;
    }

    send(data: Buffer | string, cb?: (err?: Error | null) => void): void {
        const chunk = typeof data === "string" ? Buffer.from(data) : data;
        if (!this.stream) {
            this.pendingWrites.push(chunk);
            cb?.();
        } else if (cb) this.stream.write(chunk, cb);
        else this.stream.write(chunk);
    }

    /** Ends the stream (FIN), then the WebSocket. */
    close(_code?: number, _reason?: string): void {
        if (this.closed) return;
        if (!this.stream) {
            this.ws.close();
            return;
        }
        const stream = this.stream;
        stream.end();
        setTimeout(() => stream.destroy(), 200).unref();
    }

    terminate(): void {
        this.ws.terminate();
    }

    private finish(code: number, reason: string): void {
        if (this.closed) return;
        this.closed = true;
        if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "client_close");
        this.emit("close", code, Buffer.from(reason));
    }
}

/** Starts a tunnel connection at once (like `new WebSocket(url, options)`). */
export function tunnelClient(url: string, options?: WebSocket.ClientOptions): TunnelClient {
    return new TunnelClient(new WebSocket(url, options));
}

/** Opens a tunnel connection (rejects like connectTestWs when the upgrade is refused). */
export async function connectTunnelClient(
    url: string,
    options?: WebSocket.ClientOptions
): Promise<TunnelClient> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url, options);
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
    });
    return new TunnelClient(ws);
}
