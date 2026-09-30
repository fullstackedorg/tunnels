import type { Duplex } from "node:stream";
import { createWebSocketStream, type WebSocket } from "ws";
import { CLOSE_CODES, type Reason } from "../constants.ts";

export interface StreamTeardownOptions {
    ws: WebSocket;
    duplex: Duplex;
    destinationStream?: Duplex | null;
    reason: Reason;
    error?: Error;
    onTeardownComplete?: () => void;
}

/**
 * Creates a Duplex stream from a WebSocket with allowHalfOpen: false.
 */
export function createWsDuplex(ws: WebSocket): Duplex {
    const duplex = createWebSocketStream(ws, { allowHalfOpen: false });
    const originalFinal = duplex._final;
    duplex._final = function (callback) {
        if (ws.readyState === ws.OPEN) {
            const reason: Reason = (duplex as any)._closeReason || "target_close";
            const code = CLOSE_CODES[reason] ?? 1000;
            try {
                ws.close(code, reason);
            } catch {}
        }
        originalFinal.call(this, callback);
    };

    duplex._destroy = function (err, callback) {
        if (ws.readyState === ws.OPEN) {
            const reason: Reason =
                (duplex as any)._closeReason || (err ? "stream_error" : "client_close");
            const code = CLOSE_CODES[reason] ?? (err ? 1011 : 1000);
            try {
                ws.close(code, reason);
            } catch {
                ws.terminate();
            }
            const timer = setTimeout(() => {
                if (ws.readyState !== ws.CLOSED) ws.terminate();
            }, 500);
            ws.once("close", () => {
                clearTimeout(timer);
                callback(err);
                duplex.emit("close");
            });
            return;
        }

        if (ws.readyState !== ws.CLOSED) {
            ws.terminate();
        }
        callback(err);
        duplex.emit("close");
    };

    return duplex;
}

/**
 * Symmetrical teardown routine for WebSocket and its paired stream:
 * - Sends WebSocket close frame first.
 * - Flushes remaining data and destroys underlying sockets upon receiving
 *   the WebSocket 'close' event or stream 'finish' event (with 500ms fallback safety timer).
 * - Hard errors (stream_error, ECONNRESET) or non-open ready states destroy sockets immediately.
 */
export function performSymmetricalTeardown(options: StreamTeardownOptions): void {
    const { ws, duplex, destinationStream, reason, error, onTeardownComplete } = options;
    const code = CLOSE_CODES[reason] ?? 1000;

    let completed = false;
    const cleanup = () => {
        if (completed) return;
        completed = true;

        if (!duplex.destroyed) {
            duplex.destroy(error);
        }
        if (destinationStream && !destinationStream.destroyed) {
            destinationStream.destroy(error);
        }
        if (onTeardownComplete) {
            onTeardownComplete();
        }
    };

    if (ws.readyState === ws.OPEN) {
        try {
            ws.close(code, reason);
        } catch {
            cleanup();
            return;
        }

        const timer = setTimeout(cleanup, 500);
        ws.once("close", () => {
            clearTimeout(timer);
            cleanup();
        });
    } else {
        cleanup();
    }
}
