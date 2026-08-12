import http from "node:http";
import { executeHook } from "../utils/hooks";
import { logger } from "../utils/logger";
import { IncomingMessageWithDeny } from "../http";

const notFoundData = Buffer.from("Not Found");

function notFound(res: http.ServerResponse) {
    res.writeHead(404, {
        "Content-Type": "text/plain",
        "Content-Length": notFoundData.length,
    });
    res.end(notFoundData);
}

type Route = {
    prefix: string;
    handler: (
        req: IncomingMessageWithDeny,
        res: http.ServerResponse,
    ) => Promise<boolean> | boolean;
};

const routes: Route[] = [];

export function registerRoute(
    prefix: Route["prefix"],
    handler: Route["handler"],
    prepend = false,
) {
    if (routes.some((r) => r.prefix === prefix)) {
        return;
    }

    if (prepend) {
        routes.unshift({ prefix, handler });
    } else {
        routes.push({ prefix, handler });
    }

    logger.info("API", `Registered route: ${prefix}`);
}

export function respondJSON(res: http.ServerResponse, data: any) {
    const buffer = Buffer.from(JSON.stringify(data));
    res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": buffer.byteLength,
    });
    res.end(buffer);
    return true;
}

export async function restApiRequest(
    req: IncomingMessageWithDeny,
    res: http.ServerResponse,
) {
    await executeHook("rest_api_access", req);

    if (req.destroyed) {
        return;
    }

    for (const { prefix, handler } of routes) {
        if (req.url!.startsWith(prefix)) {
            logger.info("API", `Processing request for: ${prefix}`);
            const handled = await handler(req, res);
            if (handled) {
                return;
            }
        }
    }

    logger.info("API", `Path not handled, respond not found [${req.url}]`);
    notFound(res);
}
