import http from "node:http";
import type { Duplex } from "node:stream";
import type { AppConfig } from "../utils/config.ts";
import { decorateRequest, type IncomingMessageWithDeny } from "./deny.ts";
import { runGatingHook } from "../utils/hooks.ts";
import { handleApiRequest } from "../api/index.ts";
import { resolveToken } from "../entities/cache.ts";
import { RELAY_WORKER_HEADER, wardenLifeline, wardenRelaySession } from "../warden/index.ts";
import { handleTunnelUpgrade } from "../tunnels/index.ts";
import { logger } from "../utils/logger.ts";

export type WebSocketRouteHandler = (
    req: IncomingMessageWithDeny,
    socket: Duplex,
    head: Buffer
) => void | Promise<void>;

const wsRoutes = new Map<string, WebSocketRouteHandler>();

export function registerWebSocketRoute(path: string, handler: WebSocketRouteHandler): () => void {
    wsRoutes.set(path, handler);
    return () => {
        wsRoutes.delete(path);
    };
}

export function clearWebSocketRoutes(): void {
    wsRoutes.clear();
}

export function createHttpServer(config: AppConfig): http.Server {
    const server = http.createServer(async (req, res) => {
        const socket = req.socket as unknown as Duplex;
        const decorated = decorateRequest(req, socket, config.trustedProxies, res);

        const passed = await runGatingHook("hub_request", decorated);
        if (!passed || decorated.denied) {
            return;
        }

        await handleApiRequest(decorated, res);
    });

    // A failure here (KV, IPC, a custom route) must not reject unhandled: that ends the process.
    server.on("upgrade", (req, rawSocket, head) => {
        const socket = rawSocket as Duplex;
        socket.pause();
        const decorated = decorateRequest(req, socket, config.trustedProxies);
        handleUpgrade(decorated, socket, head).catch((err) => {
            logger.error("Hub", "Upgrade failed", { reqId: decorated.id, error: err });
            decorated.deny(500, "Internal Server Error");
        });
    });

    return server;
}

// The Hub's upgrade routing: gating hook, custom routes, then edge_ / tun_ tokens.
async function handleUpgrade(
    req: IncomingMessageWithDeny,
    socket: Duplex,
    head: Buffer
): Promise<void> {
    const passed = await runGatingHook("hub_upgrade", req);
    if (!passed || req.denied) {
        return;
    }

    const rawPath = (req.url ?? "/").split("?")[0];

    // Resume raw socket so WebSocket library can process frames
    if (socket.isPaused()) {
        socket.resume();
    }

    // 1. Registered custom WebSocket route
    if (wsRoutes.has(rawPath)) {
        const handler = wsRoutes.get(rawPath)!;
        await handler(req, socket, head);
        return;
    }

    // 2. Non-root path without custom route
    if (rawPath !== "/") {
        req.deny(404, "Not Found");
        return;
    }

    // 3. Classify root upgrade by Authorization prefix
    const authHeader = req.headers.authorization;
    const token = typeof authHeader === "string" ? authHeader : undefined;

    if (!token) {
        req.deny(401, "Unauthorized");
        return;
    }

    if (token.startsWith("edg_")) {
        let resolved;
        req.resolvedAt = Date.now();
        try {
            resolved = await resolveToken(token);
        } catch {
            req.deny(503, "Service Unavailable");
            return;
        }
        if (!resolved || resolved.type !== "edge") {
            req.deny(401, "Unauthorized");
            return;
        }
        // An Edge dials its lifeline, and relay sessions naming the Hub worker they are for
        if (req.headers[RELAY_WORKER_HEADER]) {
            await wardenRelaySession(req, socket, head, resolved.entity as any);
        } else {
            await wardenLifeline(req, socket, head, resolved.entity as any);
        }
        return;
    }

    if (token.startsWith("tun_")) {
        let resolved;
        req.resolvedAt = Date.now();
        try {
            resolved = await resolveToken(token);
        } catch {
            req.deny(503, "Service Unavailable");
            return;
        }
        if (!resolved || resolved.type !== "tunnel") {
            req.deny(401, "Unauthorized");
            return;
        }
        await handleTunnelUpgrade(req, socket, head, resolved.entity as any);
        return;
    }

    req.deny(401, "Unauthorized");
}
