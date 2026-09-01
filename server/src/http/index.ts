import http from "node:http";
import { registerRoute, restApiRequest } from "../api/index.ts";
import { getEnvOrArgCLI } from "../utils/args.ts";
import { logger } from "../utils/logger.ts";
import { executeHook, registerHook } from "../utils/hooks.ts";
import {
    getMachineHeartbeatStatus,
    isMachineConnected,
    wardenRequest,
    type HeartbeatStatus,
} from "../warden/index.ts";
import { getRequestTunnelItem } from "../tunnels/index.ts";
import { tunnelProxy } from "../tunnels/proxy.ts";
import { proxiesTable, type Proxy } from "../entities/schema/proxy.ts";
import { servicesTable, type Service } from "../entities/schema/service.ts";
import { tunnelService } from "../tunnels/service.ts";
import { entityCRUD } from "../entities/index.ts";
import { machinesTable, type Machine } from "../entities/schema/machine.ts";

const Component = "HTTP Server";

const deniedRawResponse = [
    "HTTP/1.1 403 Forbidden",
    "Connection: close",
    "Content-Type: text/plain",
    "", // Blank line separating headers from body
    "Denied", // Response body
].join("\r\n");

export type IncomingMessageWithDeny = http.IncomingMessage & {
    deny: () => void;
};

function addDenyFunction(req: http.IncomingMessage) {
    (req as IncomingMessageWithDeny).deny = () => {
        req.socket.write(deniedRawResponse, () => {
            req.socket.end();
        });
        req.destroy();
    };
}

async function onRequest(
    req: IncomingMessageWithDeny,
    res: http.ServerResponse,
) {
    addDenyFunction(req);

    await executeHook("on_request", req);

    if (req.destroyed) {
        logger.info(Component, `Request destroyed in onRequest: ${req.url}`);
        return;
    }

    logger.info(Component, `on request: ${req.url}`);

    const tunnel = (await getRequestTunnelItem(req, "proxy")) as Proxy | null;
    if (tunnel) {
        return tunnelProxy(req, tunnel, res);
    }

    return restApiRequest(req, res);
}

async function onUpgrade(req: IncomingMessageWithDeny) {
    addDenyFunction(req);

    req.socket.pause();

    await executeHook("on_upgrade", req);

    if (req.destroyed) {
        logger.info(Component, `Request destroyed in onUpgrade: ${req.url}`);
        return;
    }

    logger.info("HTTP Server", `on upgrade: ${req.url}`);

    const tunnel = (await getRequestTunnelItem(
        req,
        "service",
    )) as Service | null;
    if (tunnel) {
        return tunnelService(req, tunnel);
    }

    return wardenRequest(req);
}

let server: http.Server | null = null;

export async function createServerHTTP() {
    const port = getEnvOrArgCLI(["PORT", "port", "p"]) || 3000;

    server = http.createServer();

    server.on("request", onRequest);

    server.on("upgrade", onUpgrade);

    await new Promise<void>((res) => server!.listen(port, res));

    logger.info(Component, `Listening on port ${port}`);

    registerRoute("/services", entityCRUD(servicesTable));
    registerRoute("/proxies", entityCRUD(proxiesTable));
    registerRoute("/machines", entityCRUD(machinesTable));
    registerHook(
        "get_machines",
        async (
            _,
            items: (Machine & {
                connected: boolean;
                heartbeat?: HeartbeatStatus | null;
            })[],
        ) => {
            await Promise.all(
                items.map(async (machine) => {
                    machine.connected = await isMachineConnected(machine);
                    machine.heartbeat = await getMachineHeartbeatStatus(
                        machine.id,
                    );
                }),
            );
        },
    );
}

export function stopServerHTTP() {
    server?.close();
    server = null;
}
