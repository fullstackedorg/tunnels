import type { WebSocket } from "ws";
import { DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_HEARTBEAT_TIMEOUT } from "../constants.ts";

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
            try {
                ws.close(1011, "heartbeat_timeout");
            } catch {
                ws.terminate();
            }
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
