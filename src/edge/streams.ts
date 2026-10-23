import net from "node:net";
import { isReason, type Reason } from "../constants.ts";
import type { MuxStream } from "../mux/session.ts";
import { spliceStreams, type SpliceTeardown } from "../mux/splice.ts";
import type { EdgeTunnel, RelayStreamOpen } from "../warden/types.ts";
import { runGatingHook, runAwaitedHook, dispatchTelemetry } from "../utils/hooks.ts";
import { classifyDialError } from "../utils/net.ts";

export interface EdgeStreamContext {
    reqId: string;
    client: { ip: string; correlationId?: string };
    denied: boolean;
    denyReason?: string;
    deny: () => void;
}

/** Spliced streams, for draining on shutdown and revocation. */
const activeStreams = new Map<MuxStream, SpliceTeardown>();

export function getEdgeActiveSessionCount(): number {
    return activeStreams.size;
}

/** Waits up to timeoutMs for the spliced streams to end, then ends the rest with `reason`. */
export async function drainAndCloseEdgeSessions(
    timeoutMs: number,
    reason: Reason = "edge_shutdown"
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs && activeStreams.size > 0) {
        await new Promise((r) => setTimeout(r, 50));
    }
    for (const teardown of [...activeStreams.values()]) teardown(reason);
}

function parseOpen(payload: Buffer): RelayStreamOpen | null {
    try {
        const open = JSON.parse(payload.toString("utf-8"));
        const t = open?.tunnel;
        if (typeof t?.internalHost !== "string" || !Number.isInteger(t?.internalPort)) return null;
        return {
            reqId: String(open.reqId ?? ""),
            tunnel: { ...t, metadata: t.metadata || {} },
            client: {
                ip: String(open.client?.ip ?? ""),
                correlationId: open.client?.correlationId,
            },
            connectTimeoutMs: Math.max(1, Number(open.connectTimeoutMs) || 1),
        };
    } catch {
        return null;
    }
}

function reset(stream: MuxStream, reason: Reason): void {
    if (stream.destroyed) return;
    stream.closeReason = reason;
    stream.destroy();
}

// Dials the target within the Hub's budget; a RESET from the Hub first (its runtime stream ended,
// or its deadline passed) drops the dial with the Hub's reason.
function dialTarget(
    open: RelayStreamOpen,
    stream: MuxStream,
    context: EdgeStreamContext
): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({
            host: open.tunnel.internalHost,
            port: open.tunnel.internalPort,
            // Small sequential writes (e.g. Postgres Parse/Bind/Execute) must not wait on Nagle.
            noDelay: true,
        });
        const cleanup = () => {
            clearTimeout(timer);
            stream.off("close", onHubReset);
            socket.off("error", onDialError);
        };
        const fail = (reason: Reason, err?: any) => {
            cleanup();
            socket.destroy();
            const error = err ?? new Error(`Target dial failed: ${reason}`);
            error.reason = reason;
            reject(error);
        };
        const onHubReset = () => {
            const peer = stream.peerCloseReason;
            fail(isReason(peer) ? peer : "client_aborted");
        };
        const timer = setTimeout(() => {
            dispatchTelemetry("edge_tunnel_timeout", context, open.tunnel);
            fail("connect_timeout");
        }, open.connectTimeoutMs);

        stream.once("close", onHubReset);
        socket.once("connect", () => {
            cleanup();
            socket.setKeepAlive(true, 60000);
            socket.pause();
            resolve(socket);
        });
        const onDialError = (err: any) => fail(classifyDialError(err), err);
        socket.on("error", onDialError);
    });
}

/**
 * A stream the Hub opened on a relay session: the edge_tunnel_request gate, the target dial, then
 * OPENED and a 1:1 splice to the target socket. A refusal or a failed dial answers RESET with its
 * reason. edge_tunnel_end fires once for every stream that passed the gate.
 */
export async function serveEdgeStream(stream: MuxStream, payload: Buffer): Promise<void> {
    stream.on("error", () => {});
    stream.pause();
    const open = parseOpen(payload);
    if (!open) return reset(stream, "stream_error");

    const context: EdgeStreamContext = {
        reqId: open.reqId,
        client: open.client,
        denied: false,
        deny() {
            this.denied = true;
            this.denyReason = "hook_denied";
        },
    };
    const tunnel: EdgeTunnel = open.tunnel;

    try {
        const passed = await runGatingHook("edge_tunnel_request", context, tunnel);
        if (!passed || context.denied) {
            return reset(
                stream,
                context.denyReason === "hook_error" ? "hook_error" : "hook_denied"
            );
        }
    } catch {
        return reset(stream, "hook_error");
    }
    // the Hub reset the stream while the gate ran (its runtime stream ended, or the deadline)
    if (stream.destroyed) return;

    dispatchTelemetry("edge_tunnel_start", context, tunnel);

    let target: net.Socket;
    try {
        target = await dialTarget(open, stream, context);
    } catch (err: any) {
        const reason: Reason = isReason(err?.reason) ? err.reason : "target_unreachable";
        reset(stream, reason);
        dispatchTelemetry("edge_tunnel_end", context, tunnel, reason, err);
        return;
    }

    stream.opened();
    const teardown = spliceStreams({
        stream,
        other: target,
        streamEnd: "client_close",
        otherEnd: "target_close",
        ready: runAwaitedHook("edge_tunnel_connected", context, tunnel, stream, target),
        onEnd: (reason, error) => {
            activeStreams.delete(stream);
            dispatchTelemetry("edge_tunnel_end", context, tunnel, reason, error);
        },
    });
    activeStreams.set(stream, teardown);
}
