import net from "node:net";
import { pipeline } from "node:stream";
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
    const ws = await upgradeRequest(req);
    logger.info(
        Component,
        `Handled upgrade for [${service.name} (${service.id})]`,
    );

    const socket = service.machineId
        ? await getRelayedService(service)
        : net.createConnection({
              port: service.internalPort,
              host: service.internalHost || "0.0.0.0",
          });

    const duplex = createWebSocketStream(ws);

    const cleanup = () => {
        socket.destroy();
        duplex.destroy();
        ws.close();
    };

    socket.on("error", (err) => {
        logger.error(
            Component,
            `Socket error for [${service.name} (${service.id})]: ${err.message}`,
        );
        cleanup();
    });

    ws.on("error", (err) => {
        logger.error(
            Component,
            `WebSocket error for [${service.name} (${service.id})]: ${err.message}`,
        );
        cleanup();
    });

    executeHook("tunnel_service", req, service, duplex, socket);

    pipeline(duplex, socket, () => {});
    pipeline(socket, duplex, () => {});

    req.socket.resume();
    logger.info(
        Component,
        `Tunnel Service established for [${service.name} (${service.id})]`,
    );
}
