import fs from "node:fs";
import WebSocket from "ws";
import type { AppConfig } from "../utils/config.ts";
import { MAX_STREAMS_PER_RELAY, RELAY_WORKER_HEADER, type Reason } from "../constants.ts";
import { logger } from "../utils/logger.ts";
import { MuxSession } from "../mux/session.ts";
import { closeWithReason, registerHeartbeat } from "../ws/heartbeat.ts";
import { serveEdgeStream } from "./streams.ts";

/** The Edge token: the token file (re-read, so a rolled token is picked up) or --token. */
export function readEdgeToken(config: AppConfig): string | undefined {
    if (config.tokenFile && fs.existsSync(config.tokenFile)) {
        try {
            const content = fs.readFileSync(config.tokenFile, "utf-8").trim();
            if (content) return content;
        } catch (err: any) {
            logger.warn("Edge", `Failed to read token file: ${err?.message}`);
        }
    }
    return config.token;
}

const relaySessions = new Set<WebSocket>();

export function getRelaySessionCount(): number {
    return relaySessions.size;
}

export function closeRelaySessions(reason: Reason): void {
    for (const ws of relaySessions) closeWithReason(ws, reason);
}

function dialOnce(config: AppConfig, worker: string, onClose?: () => void): Promise<boolean> {
    return new Promise((resolve) => {
        const token = readEdgeToken(config);
        if (!token || !config.hubUrl) return resolve(false);
        const ws = new WebSocket(config.hubUrl, {
            perMessageDeflate: false,
            headers: { Authorization: token, [RELAY_WORKER_HEADER]: worker },
        });
        ws.once("open", () => {
            relaySessions.add(ws);
            registerHeartbeat(ws);
            new MuxSession(ws, {
                onOpen: (stream, payload) => void serveEdgeStream(stream, payload),
                maxStreams: MAX_STREAMS_PER_RELAY,
            });
            resolve(true);
        });
        ws.once("unexpected-response", (req) => {
            req.destroy();
            resolve(false);
        });
        ws.on("error", () => resolve(false));
        ws.once("close", () => {
            if (relaySessions.delete(ws)) onClose?.();
        });
    });
}

/**
 * Dials a relay session to the Hub worker `worker` (an `open_relay` order): the Hub opens streams
 * on it, each served by serveEdgeStream. One retry after a failed dial; false when both fail.
 */
export async function openRelaySession(
    config: AppConfig,
    worker: string,
    onClose?: () => void
): Promise<boolean> {
    if (await dialOnce(config, worker, onClose)) return true;
    await new Promise((r) => setTimeout(r, 200));
    return dialOnce(config, worker, onClose);
}
