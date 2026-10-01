import net from "node:net";
import { pipeline, type Duplex } from "node:stream";
import WebSocket from "ws";
import { CLOSE_CODES, isReason, type Reason } from "../constants.ts";
import type { ConnectTunnelOrder } from "../warden/types.ts";
import { runGatingHook, runAwaitedHook, dispatchTelemetry } from "../utils/hooks.ts";
import { createWsDuplex } from "../utils/ws-stream.ts";
import { getLocalCloseReason, registerHeartbeat } from "../ws/heartbeat.ts";
import { classifyDialError } from "../utils/net.ts";

export interface EdgeOrderContext {
    reqId: string;
    ticket: string;
    client: { ip: string; correlationId?: string };
    denied: boolean;
    denyReason?: string;
    deny: () => void;
}

export interface EdgeOrderHandlers {
    onFailedBeforeHandoff: (ticket: string, reqId: string, reason: Reason) => void;
    onHandoff?: (ticket: string) => void;
    onSessionEnded?: (ticket: string) => void;
}

interface InFlightSetup {
    cancel: (reason: Reason) => void;
}

const inFlightSetups = new Map<string, InFlightSetup>();
const activeEdgeSessions = new Map<string, { close: (code: number, reason: Reason) => void }>();

export function cancelEdgeOrder(ticket: string, reason: Reason = "client_aborted"): boolean {
    const setup = inFlightSetups.get(ticket);
    if (setup) {
        inFlightSetups.delete(ticket);
        setup.cancel(reason);
        return true;
    }
    return false;
}

export function getEdgeActiveSessionCount(): number {
    return activeEdgeSessions.size;
}

export async function drainAndCloseEdgeSessions(
    timeoutMs: number,
    reason: Reason = "edge_shutdown"
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs && activeEdgeSessions.size > 0) {
        await new Promise((r) => setTimeout(r, 50));
    }
    const code = CLOSE_CODES[reason] ?? 1001;
    for (const [ticket, session] of activeEdgeSessions.entries()) {
        activeEdgeSessions.delete(ticket);
        try {
            session.close(code, reason);
        } catch {}
    }
}

export async function processEdgeOrder(
    order: ConnectTunnelOrder,
    hubUrl: string,
    handlers: EdgeOrderHandlers
): Promise<void> {
    const context: EdgeOrderContext = {
        reqId: order.reqId,
        ticket: order.ticket,
        client: order.client,
        denied: false,
        deny() {
            this.denied = true;
            this.denyReason = "hook_denied";
        },
    };

    // 1. Gate: edge_tunnel_request hook
    try {
        const passed = await runGatingHook("edge_tunnel_request", context, order.tunnel);
        if (!passed || context.denied) {
            const reason: Reason =
                context.denyReason === "hook_error" ? "hook_error" : "hook_denied";
            handlers.onFailedBeforeHandoff(order.ticket, order.reqId, reason);
            return;
        }
    } catch {
        handlers.onFailedBeforeHandoff(order.ticket, order.reqId, "hook_error");
        return;
    }

    // 2. Start & Parallel dials
    dispatchTelemetry("edge_tunnel_start", context, order.tunnel);

    let isHandoffComplete = false;
    let isCancelled = false;
    let targetSocket: net.Socket | null = null;
    let relayedWs: WebSocket | null = null;
    let relayedDuplex: Duplex | null = null;

    const connectTimeoutMs = Math.max(1, order.connectTimeoutMs);

    inFlightSetups.set(order.ticket, {
        cancel: (reason) => {
            isCancelled = true;
            if (targetSocket) {
                try {
                    targetSocket.destroy();
                } catch {}
            }
            if (relayedWs) {
                try {
                    relayedWs.terminate();
                } catch {}
            }
            if (relayedDuplex && !relayedDuplex.destroyed) {
                try {
                    relayedDuplex.destroy();
                } catch {}
            }
            dispatchTelemetry("edge_tunnel_end", context, order.tunnel, reason);
        },
    });

    // Dial target TCP
    const targetPromise = new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection({
            host: order.tunnel.internalHost,
            port: order.tunnel.internalPort,
        });
        targetSocket = s;

        const timer = setTimeout(() => {
            s.destroy();
            dispatchTelemetry("edge_tunnel_timeout", context, order.tunnel);
            const err: any = new Error("Target dial timed out");
            err.reason = "connect_timeout";
            reject(err);
        }, connectTimeoutMs);

        s.once("connect", () => {
            clearTimeout(timer);
            s.setKeepAlive(true, 60000);
            s.pause();
            resolve(s);
        });

        s.on("error", (err: any) => {
            clearTimeout(timer);
            s.destroy();
            err.reason = classifyDialError(err);
            reject(err);
        });
    });

    // Dial relayed WebSocket
    const wsHeaders: Record<string, string> = {
        Authorization: order.ticket,
    };
    if (order.client.correlationId) {
        wsHeaders["x-request-id"] = order.client.correlationId;
    }
    const wsClient = new WebSocket(hubUrl, { headers: wsHeaders, perMessageDeflate: false });
    relayedWs = wsClient;
    relayedDuplex = createWsDuplex(wsClient);
    relayedDuplex.on("error", () => {});
    relayedDuplex.pause();

    const relayedPromise = new Promise<WebSocket>((resolve, reject) => {
        const timer = setTimeout(() => {
            try {
                wsClient.terminate();
            } catch {}
            const err: any = new Error("Relayed dial timed out");
            err.reason = "connect_timeout";
            reject(err);
        }, connectTimeoutMs);

        wsClient.once("open", () => {
            clearTimeout(timer);
            isHandoffComplete = true;
            if (handlers.onHandoff) handlers.onHandoff(order.ticket);
            resolve(wsClient);
        });

        wsClient.once("close", (_code, reasonBuf) => {
            clearTimeout(timer);
            const reasonStr = reasonBuf ? reasonBuf.toString("utf-8") : "";
            const err: any = new Error(`Relayed dial closed: ${reasonStr}`);
            err.reason = isReason(reasonStr) ? reasonStr : "relay_dial_failed";
            reject(err);
        });

        wsClient.on("error", (err: any) => {
            clearTimeout(timer);
            try {
                wsClient.terminate();
            } catch {}
            err.reason = "relay_dial_failed";
            reject(err);
        });

        wsClient.once("unexpected-response", (_req, res) => {
            clearTimeout(timer);
            try {
                wsClient.terminate();
            } catch {}
            const err: any = new Error(`Relayed dial rejected: ${res.statusCode}`);
            err.reason = "relay_dial_failed";
            reject(err);
        });
    });

    let target: net.Socket;
    let ws: WebSocket;

    try {
        [target, ws] = await Promise.all([targetPromise, relayedPromise]);
    } catch (err: any) {
        inFlightSetups.delete(order.ticket);
        if (isCancelled) return;

        const reason: Reason = err?.reason || "relay_dial_failed";
        if (targetSocket) {
            try {
                (targetSocket as any).destroy();
            } catch {}
        }

        if (isHandoffComplete && relayedWs && relayedWs.readyState === WebSocket.OPEN) {
            // Target dial failed after handoff: close relayed socket with 1014
            const code = CLOSE_CODES[reason] ?? 1014;
            try {
                relayedWs.close(code, reason);
            } catch {}
            if (relayedDuplex && !relayedDuplex.destroyed) {
                try {
                    relayedDuplex.destroy();
                } catch {}
            }
        } else {
            if (relayedWs) {
                try {
                    relayedWs.terminate();
                } catch {}
            }
            if (relayedDuplex && !relayedDuplex.destroyed) {
                try {
                    relayedDuplex.destroy();
                } catch {}
            }
            handlers.onFailedBeforeHandoff(order.ticket, order.reqId, reason);
        }

        dispatchTelemetry("edge_tunnel_end", context, order.tunnel, reason, err);
        return;
    }

    inFlightSetups.delete(order.ticket);
    if (isCancelled) return;

    registerHeartbeat(ws);

    let closed = false;
    const teardown = (reason: Reason, error?: Error) => {
        if (closed) return;
        closed = true;
        activeEdgeSessions.delete(order.ticket);

        const code = CLOSE_CODES[reason] ?? 1000;

        if (ws.readyState === ws.OPEN) {
            try {
                ws.close(code, reason);
            } catch {}

            const cleanup = () => {
                if (relayedDuplex && !relayedDuplex.destroyed) relayedDuplex.destroy(error);
                if (!target.destroyed) target.destroy(error);
            };
            const timer = setTimeout(cleanup, 500);
            ws.once("close", () => {
                clearTimeout(timer);
                cleanup();
            });
        } else {
            if (relayedDuplex && !relayedDuplex.destroyed) relayedDuplex.destroy(error);
            if (!target.destroyed) target.destroy(error);
        }

        if (handlers.onSessionEnded) {
            handlers.onSessionEnded(order.ticket);
        }
        dispatchTelemetry("edge_tunnel_end", context, order.tunnel, reason, error);
    };

    activeEdgeSessions.set(order.ticket, {
        close: (code, reason) => {
            teardown(reason);
        },
    });

    pipeline(relayedDuplex, target, (err) => {
        teardown(err ? "stream_error" : "client_close", err ?? undefined);
    });

    pipeline(target, relayedDuplex, (err) => {
        teardown(err ? "stream_error" : "target_close", err ?? undefined);
    });

    ws.once("close", (_code, reasonBuf) => {
        const peer = reasonBuf?.toString("utf-8");
        teardown(getLocalCloseReason(ws) ?? (isReason(peer) ? peer : "client_close"));
    });

    await runAwaitedHook("edge_tunnel_connected", context, order.tunnel, relayedDuplex, target);

    relayedDuplex.resume();
    target.resume();
}
