import WebSocket from "ws";
import type { AppConfig } from "../utils/config.ts";
import type { Reason } from "../constants.ts";
import { logger } from "../utils/logger.ts";
import { registerHeartbeat } from "../ws/heartbeat.ts";
import { drainAndCloseEdgeSessions } from "./streams.ts";
import { closeRelaySessions, openRelaySession, readEdgeToken } from "./relay.ts";

export interface EdgeLifelineOptions {
    config: AppConfig;
    onOrder?: (order: any) => void;
    /** Multi-worker Primary: sessions live in workers, so draining is delegated to them. */
    onRevoked?: (drainTimeoutMs: number, reason: Reason) => void;
}

export class EdgeLifeline {
    private config: AppConfig;
    private ws: WebSocket | null = null;
    private reconnectAttempt = 0;
    private isRunning = false;
    private isRevoked = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private onOrder?: (order: any) => void;
    private onRevoked?: (drainTimeoutMs: number, reason: Reason) => void;

    constructor(options: EdgeLifelineOptions) {
        this.config = options.config;
        this.onOrder = options.onOrder;
        this.onRevoked = options.onRevoked;
    }

    private getBackoffDelay(): number {
        const { reconnectInterval, maxReconnectInterval } = this.config;
        const maxBackoff = Math.min(
            maxReconnectInterval,
            reconnectInterval * Math.pow(2, this.reconnectAttempt)
        );
        return Math.floor(Math.random() * maxBackoff * 1000);
    }

    private scheduleReconnect(delayMs: number): void {
        if (!this.isRunning || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delayMs);
    }

    private handleRevocation(): void {
        this.isRevoked = true;
        logger.warn("Edge", "Edge token revoked");
        const drainMs = this.config.drainTimeout * 1000;
        if (this.onRevoked) {
            this.onRevoked(drainMs, "token_rolled");
        } else {
            drainAndCloseEdgeSessions(drainMs, "token_rolled")
                .catch(() => {})
                .finally(() => closeRelaySessions("token_rolled"));
        }
        this.scheduleReconnect(this.config.revokedPollInterval * 1000);
    }

    start(): void {
        this.isRunning = true;
        this.connect();
    }

    private connect(): void {
        if (!this.isRunning) return;

        const token = readEdgeToken(this.config);
        if (!token) {
            logger.error("Edge", "No edge token available to connect");
            this.scheduleReconnect(this.config.reconnectInterval * 1000);
            return;
        }

        const hubUrl = this.config.hubUrl;
        if (!hubUrl) {
            logger.error("Edge", "HUB_URL is required for Edge mode");
            return;
        }

        if (this.isRevoked) {
            logger.warn("Edge", "Edge token revoked (polling for recovery)");
        }

        const ws = new WebSocket(hubUrl, {
            perMessageDeflate: false,
            headers: {
                Authorization: token,
                version: "0.1.0",
            },
        });
        this.ws = ws;

        let resetTimer: NodeJS.Timeout | null = null;

        ws.once("open", () => {
            logger.info("Edge", `Connected lifeline to Hub: ${hubUrl}`);
            this.isRevoked = false;

            resetTimer = setTimeout(() => {
                this.reconnectAttempt = 0;
            }, this.config.heartbeatInterval * 1000);

            registerHeartbeat(ws, {
                onTimeout: () => {
                    logger.warn("Edge", "Lifeline heartbeat timeout");
                },
            });
        });

        ws.on("message", (data: Buffer | string) => {
            try {
                const text = typeof data === "string" ? data : data.toString("utf-8");
                const order = JSON.parse(text);
                if (this.isRevoked) return;

                if (this.onOrder) {
                    this.onOrder(order);
                } else if (order.type === "open_relay" && typeof order.worker === "string") {
                    openRelaySession(this.config, order.worker).then((ok) => {
                        if (!ok) this.sendRelayFailed(order.worker);
                    });
                }
            } catch (err: any) {
                logger.warn("Edge", `Failed to parse lifeline message: ${err?.message}`);
            }
        });

        ws.once("unexpected-response", (_req, res) => {
            if (resetTimer) clearTimeout(resetTimer);
            const status = res.statusCode;
            logger.warn("Edge", `Lifeline handshake rejected with HTTP ${status}`);

            if (status === 401) {
                this.handleRevocation();
            } else if (status === 403) {
                this.scheduleReconnect(this.config.maxReconnectInterval * 1000);
            } else if (status === 429) {
                const retryAfter = parseInt(String(res.headers["retry-after"] || "0"), 10);
                const delay = retryAfter > 0 ? retryAfter * 1000 : this.getBackoffDelay();
                this.scheduleReconnect(delay);
            } else {
                this.reconnectAttempt++;
                this.scheduleReconnect(this.getBackoffDelay());
            }
        });

        ws.once("close", (_code, reasonBuf) => {
            if (resetTimer) clearTimeout(resetTimer);
            const reason = reasonBuf ? reasonBuf.toString("utf-8") : "";

            if (reason === "token_rolled" || reason === "edge_deleted") {
                this.handleRevocation();
            } else if (reason === "superseded") {
                logger.warn("Edge", "Lifeline superseded by another connection");
                this.scheduleReconnect(this.config.maxReconnectInterval * 1000);
            } else if (!this.isRevoked) {
                this.reconnectAttempt++;
                this.scheduleReconnect(this.getBackoffDelay());
            }
        });

        ws.once("error", () => {
            // Handled by close event
        });
    }

    /** Tells the Hub the relay session `worker` asked for could not be dialed. */
    sendRelayFailed(worker: string): void {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: "open_relay_failed", worker }));
            } catch {}
        }
    }

    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            try {
                this.ws.close(1001, "edge_shutdown");
            } catch {}
        }
        await drainAndCloseEdgeSessions(this.config.shutdownTimeout * 1000, "edge_shutdown");
        closeRelaySessions("edge_shutdown");
    }
}
