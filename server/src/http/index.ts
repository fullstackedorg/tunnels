import http from "node:http";
import { registerRoute, restApiRequest } from "../api/index";
import { getEnvOrArgCLI } from "../utils/args";
import { logger } from "../utils/logger";
import { isMachineConnected, wardenRequest } from "../warden/index";
import { executeHook, registerHook } from "../utils/hooks";
import { getRequestTunnelItem } from "../tunnels/index";
import { tunnelProxy } from "../tunnels/proxy";
import { proxiesTable, Proxy } from "../entities/schema/proxy";
import { Service, servicesTable } from "../entities/schema/service";
import { tunnelService } from "../tunnels/service";
import { entityCRUD } from "../entities/index";
import { machinesTable, Machine } from "../entities/schema/machine";

const Component = "HTTP Server";

async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    await executeHook("on_request", req);

    if (req.destroyed) {
        logger.info(Component, `Request destroyed in onRequest: ${req.url}`);
        return res.end();
    }

    logger.info(Component, `on request: ${req.url}`);

    const tunnel = (await getRequestTunnelItem(req, "proxy")) as Proxy | null;
    if (tunnel) {
        return tunnelProxy(req, tunnel, res);
    }

    return restApiRequest(req, res);
}

async function onUpgrade(req: http.IncomingMessage) {
    req.socket.pause();

    await executeHook("on_upgrade", req);

    if (req.destroyed) {
        logger.info(Component, `Request destroyed in onUpgrade: ${req.url}`);
        return req.socket.end();
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
        async (_, items: (Machine & { connected: boolean })[]) => {
            items.forEach((machine) => {
                machine.connected = isMachineConnected(machine);
            });
        },
    );
}

export function stopServerHTTP() {
    server?.close();
    server = null;
}
