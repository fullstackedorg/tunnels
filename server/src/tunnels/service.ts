import net from "node:net";
import { pipeline, type Duplex } from "node:stream";
import { type Service } from "../entities/schema/service.ts";
import { logger } from "../utils/logger.ts";
import { getByToken } from "../entities/index.ts";
import { servicesTable } from "../entities/schema/service.ts";
import { createWebSocketStream, upgradeRequest } from "../utils/ws.ts";
import { getRelayedService } from "../warden/index.ts";
import { executeHook } from "../utils/hooks.ts";
import type { IncomingMessageWithDeny } from "../http/index.ts";

const Component = "Tunnel Service";

export async function isRequestForTunnelService(req: IncomingMessageWithDeny) {
    const authorization = req.headers.authorization;
    return !!(await getByToken(servicesTable, authorization));
}

export async function tunnelService(
    req: IncomingMessageWithDeny,
    service: Service,
) {
    const startTime = Date.now();
    executeHook("tunnel_service_start", req, service);

    const ws = await upgradeRequest(req);
    logger.info(
        Component,
        `Handled upgrade for [${service.name} (${service.id})]`,
    );

    let socket: Duplex;
    try {
        if (service.machineId) {
            logger.info(
                Component,
                `Requesting relayed socket for [${service.name}] from machine [${service.machineId}]`,
            );
            socket = await getRelayedService(service, req);
            logger.info(
                Component,
                `Relayed socket acquired for [${service.name}] from machine [${service.machineId}] in ${Date.now() - startTime}ms`,
            );
        } else {
            socket = net.createConnection({
                port: service.internalPort,
                host: service.internalHost || "0.0.0.0",
            });
        }
    } catch (err: any) {
        logger.error(
            Component,
            `Failed to acquire socket for [${service.name} (${service.id})]: ${err?.message || err}`,
        );
        try {
            ws.close(
                1011,
                `Failed to reach service: ${err?.message || "connection error"}`,
            );
        } catch {}
        executeHook("tunnel_service_end", req, service, {
            durationMs: Date.now() - startTime,
            clientToTargetBytes: 0,
            targetToClientBytes: 0,
            reason: `socket_acquisition_failed: ${err?.message || err}`,
        });
        return;
    }

    const duplex = createWebSocketStream(ws);

    let clientToTargetBytes = 0;
    let targetToClientBytes = 0;
    let receivedFirstFromClient = false;
    let receivedFirstFromTarget = false;

    duplex.on("data", (chunk: Buffer) => {
        clientToTargetBytes += chunk.length;
        if (!receivedFirstFromClient) {
            receivedFirstFromClient = true;
            logger.info(
                Component,
                `Received first bytes from client for [${service.name}] (${chunk.length}B)`,
            );
        }
    });

    socket.on("data", (chunk: Buffer) => {
        targetToClientBytes += chunk.length;
        if (!receivedFirstFromTarget) {
            receivedFirstFromTarget = true;
            logger.info(
                Component,
                `Received first bytes from target for [${service.name}] (${chunk.length}B)`,
            );
        }
    });

    let isCleanedUp = false;
    const cleanup = (reason: string) => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        const durationMs = Date.now() - startTime;
        logger.info(
            Component,
            `Tunnel Service closed for [${service.name} (${service.id})] (duration: ${durationMs}ms, client->target: ${clientToTargetBytes}B, target->client: ${targetToClientBytes}B, reason: ${reason})`,
        );
        socket.destroy();
        duplex.destroy();
        try {
            ws.close();
        } catch {}
        executeHook("tunnel_service_end", req, service, {
            durationMs,
            clientToTargetBytes,
            targetToClientBytes,
            reason,
        });
    };

    socket.on("error", (err) => {
        logger.error(
            Component,
            `Socket error for [${service.name} (${service.id})]: ${err.message}`,
        );
        cleanup(`socket_error: ${err.message}`);
    });
    socket.on("close", () => cleanup("socket_close"));

    ws.on("error", (err) => {
        logger.error(
            Component,
            `WebSocket error for [${service.name} (${service.id})]: ${err.message}`,
        );
        cleanup(`websocket_error: ${err.message}`);
    });
    ws.on("close", (code, reason) => {
        cleanup(`websocket_close:${code}:${reason?.toString() || ""}`);
    });

    executeHook("tunnel_service", req, service, duplex, socket);
    executeHook("tunnel_service_connected", req, service, duplex, socket);

    pipeline(duplex, socket, (err) => {
        if (err) {
            cleanup(`pipeline_client_to_target_error: ${err.message}`);
        } else {
            cleanup("pipeline_client_to_target_end");
        }
    });
    pipeline(socket, duplex, (err) => {
        if (err) {
            cleanup(`pipeline_target_to_client_error: ${err.message}`);
        } else {
            cleanup("pipeline_target_to_client_end");
        }
    });

    req.socket.resume();
    logger.info(
        Component,
        `Tunnel Service established for [${service.name} (${service.id})]`,
    );
}
