import type { ServerResponse } from "node:http";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import { isValidUUID } from "../entities/validation.ts";
import { sendJson } from "./helpers.ts";
import {
    handleTunnelsList,
    handleTunnelCreate,
    handleTunnelGet,
    handleTunnelUpdate,
    handleTunnelDelete,
    handleTunnelRollToken,
} from "./tunnels.ts";
import {
    handleEdgesList,
    handleEdgeCreate,
    handleEdgeGet,
    handleEdgeUpdate,
    handleEdgeDelete,
    handleEdgeRollToken,
} from "./edges.ts";

export async function dispatchBuiltinRoute(
    req: IncomingMessageWithDeny,
    res: ServerResponse
): Promise<boolean> {
    const rawPath = (req.url ?? "/").split("?")[0];
    const method = req.method?.toUpperCase();

    // /tunnels
    if (rawPath === "/tunnels") {
        if (method === "GET") {
            await handleTunnelsList(req, res);
            return true;
        }
        if (method === "POST") {
            await handleTunnelCreate(req, res);
            return true;
        }
    }

    const tunnelRollMatch = rawPath.match(/^\/tunnels\/([^/]+)\/roll-token$/);
    if (tunnelRollMatch && method === "POST") {
        const id = tunnelRollMatch[1];
        if (!isValidUUID(id)) {
            sendJson(res, 400, { error: "Invalid identifier" });
            return true;
        }
        await handleTunnelRollToken(req, res, id);
        return true;
    }

    const tunnelIdMatch = rawPath.match(/^\/tunnels\/([^/]+)$/);
    if (tunnelIdMatch) {
        const id = tunnelIdMatch[1];
        if (method === "GET" || method === "PUT" || method === "PATCH" || method === "DELETE") {
            if (!isValidUUID(id)) {
                sendJson(res, 400, { error: "Invalid identifier" });
                return true;
            }
        }
        if (method === "GET") {
            await handleTunnelGet(req, res, id);
            return true;
        }
        if (method === "PUT" || method === "PATCH") {
            await handleTunnelUpdate(req, res, id);
            return true;
        }
        if (method === "DELETE") {
            await handleTunnelDelete(req, res, id);
            return true;
        }
    }

    // /edges
    if (rawPath === "/edges") {
        if (method === "GET") {
            await handleEdgesList(req, res);
            return true;
        }
        if (method === "POST") {
            await handleEdgeCreate(req, res);
            return true;
        }
    }

    const edgeRollMatch = rawPath.match(/^\/edges\/([^/]+)\/roll-token$/);
    if (edgeRollMatch && method === "POST") {
        const id = edgeRollMatch[1];
        if (!isValidUUID(id)) {
            sendJson(res, 400, { error: "Invalid identifier" });
            return true;
        }
        await handleEdgeRollToken(req, res, id);
        return true;
    }

    const edgeIdMatch = rawPath.match(/^\/edges\/([^/]+)$/);
    if (edgeIdMatch) {
        const id = edgeIdMatch[1];
        if (method === "GET" || method === "PUT" || method === "PATCH" || method === "DELETE") {
            if (!isValidUUID(id)) {
                sendJson(res, 400, { error: "Invalid identifier" });
                return true;
            }
        }
        if (method === "GET") {
            await handleEdgeGet(req, res, id);
            return true;
        }
        if (method === "PUT" || method === "PATCH") {
            await handleEdgeUpdate(req, res, id);
            return true;
        }
        if (method === "DELETE") {
            await handleEdgeDelete(req, res, id);
            return true;
        }
    }

    return false;
}
