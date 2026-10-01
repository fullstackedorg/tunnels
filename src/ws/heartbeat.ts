import type { WebSocket } from "ws";
import type { Reason } from "../constants.ts";
import {
    CLOSE_CODES,
    DEFAULT_HEARTBEAT_INTERVAL,
    DEFAULT_HEARTBEAT_TIMEOUT,
} from "../constants.ts";

/** Grace period for a dead peer's close handshake before the socket is destroyed. */
const TERMINATE_GRACE_MS = 1000;

const localCloseReasons = new WeakMap<WebSocket, Reason>();

/**
 * Closes a WebSocket with a taxonomy reason and remembers that reason locally, so close
 * handlers report it even when the peer never answers the close handshake.
 */
export function closeWithReason(ws: WebSocket, reason: Reason): void {
    if (!localCloseReasons.has(ws)) localCloseReasons.set(ws, reason);
    if (ws.readyState !== ws.OPEN) return;
    try {
        ws.close(CLOSE_CODES[reason], reason);
    } catch {
        ws.terminate();
    }
}

/** The reason this process closed the WebSocket with, if it initiated the close. */
export function getLocalCloseReason(ws: WebSocket): Reason | undefined {
    return localCloseReasons.get(ws);
}

interface HeartbeatRecord {
    ws: WebSocket;
    lastReceived: number;
    onSweep?: () => void;
    onTimeout?: () => void;
}

const connections = new Map<WebSocket, HeartbeatRecord>();
let sweepIntervalMs = DEFAULT_HEARTBEAT_INTERVAL * 1000;
let timeoutLimitMs = DEFAULT_HEARTBEAT_TIMEOUT * 1000;
let sweepTimer: NodeJS.Timeout | null = null;

function ensureSweepTimer(): void {
    if (!sweepTimer) {
        sweepTimer = setInterval(runSweep, sweepIntervalMs);
        sweepTimer.unref();
    }
}

function runSweep(): void {
    const now = Date.now();
    for (const [ws, record] of connections) {
        if (ws.readyState !== ws.OPEN) {
            connections.delete(ws);
            continue;
        }

        if (now - record.lastReceived >= timeoutLimitMs) {
            connections.delete(ws);
            if (record.onTimeout) {
                record.onTimeout();
            }
            closeWithReason(ws, "heartbeat_timeout");
            setTimeout(() => {
                if (ws.readyState !== ws.CLOSED) ws.terminate();
            }, TERMINATE_GRACE_MS).unref();
            continue;
        }

        if (record.onSweep) {
            try {
                record.onSweep();
            } catch {
                // ignore sweep errors
            }
        }

        try {
            ws.ping();
        } catch {
            // ignore ping errors
        }
    }

    if (connections.size === 0 && sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}

export function setHeartbeatConfig(intervalSeconds: number, timeoutSeconds: number): void {
    sweepIntervalMs = intervalSeconds * 1000;
    timeoutLimitMs = timeoutSeconds * 1000;
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
        ensureSweepTimer();
    }
}

export function registerHeartbeat(
    ws: WebSocket,
    options?: { onSweep?: () => void; onTimeout?: () => void }
): () => void {
    const record: HeartbeatRecord = {
        ws,
        lastReceived: Date.now(),
        onSweep: options?.onSweep,
        onTimeout: options?.onTimeout,
    };

    const onFrame = () => {
        record.lastReceived = Date.now();
    };

    ws.on("pong", onFrame);
    ws.on("ping", onFrame);
    ws.on("message", onFrame);

    connections.set(ws, record);
    ensureSweepTimer();

    const cleanup = () => {
        ws.off("pong", onFrame);
        ws.off("ping", onFrame);
        ws.off("message", onFrame);
        connections.delete(ws);
        if (connections.size === 0 && sweepTimer) {
            clearInterval(sweepTimer);
            sweepTimer = null;
        }
    };

    ws.once("close", cleanup);
    return cleanup;
}

export function unregisterHeartbeat(ws: WebSocket): void {
    connections.delete(ws);
    if (connections.size === 0 && sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}

export function stopHeartbeat(): void {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
    connections.clear();
}
