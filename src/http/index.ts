import http from "node:http";
import type { Duplex } from "node:stream";
import type { AppConfig } from "../utils/config.ts";
import { decorateRequest, type IncomingMessageWithDeny } from "./deny.ts";
import { runGatingHook } from "../utils/hooks.ts";
import { handleApiRequest } from "../api/index.ts";
import { resolveToken } from "../entities/cache.ts";
import { wardenLifeline, wardenRelayedSocket } from "../warden/index.ts";
import { handleTunnelUpgrade } from "../tunnels/index.ts";

export type WebSocketRouteHandler = (
    req: IncomingMessageWithDeny,
    socket: Duplex,
    head: Buffer
) => void;

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

    server.on("upgrade", async (req, rawSocket, head) => {
        const socket = rawSocket as Duplex;
        socket.pause();

        const decorated = decorateRequest(req, socket, config.trustedProxies);

        const passed = await runGatingHook("hub_upgrade", decorated);
        if (!passed || decorated.denied) {
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
            handler(decorated, socket, head);
            return;
        }

        // 2. Non-root path without custom route
        if (rawPath !== "/") {
            decorated.deny(404, "Not Found");
            return;
        }

        // 3. Classify root upgrade by Authorization prefix
        const authHeader = req.headers.authorization;
        const token = typeof authHeader === "string" ? authHeader : undefined;

        if (!token) {
            decorated.deny(401, "Unauthorized");
            return;
        }

        if (token.startsWith("tmp_")) {
            await wardenRelayedSocket(decorated, socket, head);
            return;
        }

        if (token.startsWith("edg_")) {
            let resolved;
            try {
                resolved = await resolveToken(token);
            } catch {
                decorated.deny(503, "Service Unavailable");
                return;
            }
            if (!resolved || resolved.type !== "edge") {
                decorated.deny(401, "Unauthorized");
                return;
            }
            await wardenLifeline(decorated, socket, head, resolved.entity as any);
            return;
        }

        if (token.startsWith("tun_")) {
            let resolved;
            try {
                resolved = await resolveToken(token);
            } catch {
                decorated.deny(503, "Service Unavailable");
                return;
            }
            if (!resolved || resolved.type !== "tunnel") {
                decorated.deny(401, "Unauthorized");
                return;
            }
            await handleTunnelUpgrade(decorated, socket, head, resolved.entity as any);
            return;
        }

        decorated.deny(401, "Unauthorized");
    });

    return server;
}
