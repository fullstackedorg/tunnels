import type { ServerResponse } from "node:http";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Tunnel } from "../entities/schema.ts";
import { storage } from "../storage/index.ts";
import { generateToken } from "../utils/token.ts";
import { validateEntityPayload } from "../entities/validation.ts";
import { cacheUpdateEntity, cacheRollToken, cacheDeleteEntity } from "../entities/cache.ts";
import { runGatingHook, runPostQueryHook, runAwaitedHook } from "../utils/hooks.ts";
import { severSessions } from "../tunnels/registry.ts";
import { readJsonBody, parseQueryParams, sendJson } from "./helpers.ts";

export async function handleTunnelsList(
    req: IncomingMessageWithDeny,
    res: ServerResponse
): Promise<void> {
    const { query, error } = parseQueryParams(req.url ?? "/tunnels");
    if (error) {
        sendJson(res, 400, { error });
        return;
    }

    const scopePassed = await runGatingHook("scope_tunnel", req, query, "list");
    if (!scopePassed || req.denied) return;

    const { items, total } = await storage.list("tunnel", query);
    await runPostQueryHook("list_tunnel_done", req, items);
    if (req.denied) return;

    sendJson(res, 200, items, { "X-Total-Count": String(total) });
}

export async function handleTunnelCreate(
    req: IncomingMessageWithDeny,
    res: ServerResponse
): Promise<void> {
    let payload: any;
    try {
        payload = await readJsonBody(req);
    } catch (err: any) {
        sendJson(res, err.statusCode || 400, { error: err.message });
        return;
    }

    const v1 = validateEntityPayload("tunnel", payload, false);
    if (!v1.valid) {
        sendJson(res, 400, { error: v1.error, fields: v1.fields });
        return;
    }

    const gatePassed = await runGatingHook("create_tunnel", req, payload);
    if (!gatePassed || req.denied) return;

    const v2 = validateEntityPayload("tunnel", payload, false);
    if (!v2.valid) {
        sendJson(res, 500, { error: "Hook introduced invalid fields", fields: v2.fields });
        return;
    }

    if (payload.edgeId) {
        const edge = await storage.get("edge", payload.edgeId);
        if (!edge) {
            sendJson(res, 400, { error: "Invalid edge identifier" });
            return;
        }
    }

    let item: any;
    try {
        const token = generateToken("tun_");
        item = await storage.transaction(async (tx) => {
            return await tx.add("tunnel", {
                ...payload,
                token,
                metadata: payload.metadata || {},
                edgeId: payload.edgeId || null,
            });
        });
    } catch (err: any) {
        if (err?.message?.includes("Conflict")) {
            sendJson(res, 409, { error: err.message });
            return;
        }
        sendJson(res, 500, { error: err?.message || "Internal Server Error" });
        return;
    }

    await cacheUpdateEntity("tunnel", item as Tunnel);
    await runAwaitedHook("create_tunnel_done", req, item);
    sendJson(res, 201, item);
}

export async function handleTunnelGet(
    req: IncomingMessageWithDeny,
    res: ServerResponse,
    id: string
): Promise<void> {
    const { query } = parseQueryParams(req.url ?? `/tunnels/${id}`);
    const scopePassed = await runGatingHook("scope_tunnel", req, query, "read");
    if (!scopePassed || req.denied) return;

    const item = await storage.get("tunnel", id, query);
    if (!item) {
        sendJson(res, 404, { error: "Not Found" });
        return;
    }

    await runPostQueryHook("read_tunnel_done", req, item);
    if (req.denied) return;

    sendJson(res, 200, item);
}

export async function handleTunnelUpdate(
    req: IncomingMessageWithDeny,
    res: ServerResponse,
    id: string
): Promise<void> {
    const { query } = parseQueryParams(req.url ?? `/tunnels/${id}`);
    const scopePassed = await runGatingHook("scope_tunnel", req, query, "update");
    if (!scopePassed || req.denied) return;

    let updates: any;
    try {
        updates = await readJsonBody(req);
    } catch (err: any) {
        sendJson(res, err.statusCode || 400, { error: err.message });
        return;
    }

    const v1 = validateEntityPayload("tunnel", updates, true);
    if (!v1.valid) {
        sendJson(res, 400, { error: v1.error, fields: v1.fields });
        return;
    }

    let existing: Tunnel | null = null;
    let updated: Tunnel | null = null;

    try {
        await storage.transaction(async (tx) => {
            existing = (await tx.get("tunnel", id, query)) as Tunnel;
            if (!existing) return;

            const gatePassed = await runGatingHook("update_tunnel", req, existing, updates);
            if (!gatePassed || req.denied) return;

            const v2 = validateEntityPayload("tunnel", updates, true);
            if (!v2.valid) {
                throw new Error("Hook introduced invalid fields: " + JSON.stringify(v2.fields));
            }

            if ("edgeId" in updates && updates.edgeId !== null) {
                const edge = await tx.get("edge", updates.edgeId);
                if (!edge) {
                    const err: any = new Error("Invalid edge identifier");
                    err.statusCode = 400;
                    throw err;
                }
            }

            updated = (await tx.update("tunnel", id, updates, query)) as Tunnel;
        });
    } catch (err: any) {
        if (err.statusCode === 400) {
            sendJson(res, 400, { error: err.message });
            return;
        }
        if (err.message?.includes("Conflict")) {
            sendJson(res, 409, { error: err.message });
            return;
        }
        sendJson(res, 500, { error: err.message });
        return;
    }

    if (req.denied) return;
    if (!existing || !updated) {
        sendJson(res, 404, { error: "Not Found" });
        return;
    }

    await cacheUpdateEntity("tunnel", updated);

    // Sever sessions if internalHost, internalPort, or edgeId changed
    const hostChanged =
        updates.internalHost && updates.internalHost !== (existing as Tunnel).internalHost;
    const portChanged =
        updates.internalPort && updates.internalPort !== (existing as Tunnel).internalPort;
    const edgeChanged = "edgeId" in updates && updates.edgeId !== (existing as Tunnel).edgeId;
    if (hostChanged || portChanged || edgeChanged) {
        await severSessions({ tunnelId: id }, "tunnel_updated");
    }

    await runAwaitedHook("update_tunnel_done", req, updated);
    sendJson(res, 200, updated);
}

export async function handleTunnelDelete(
    req: IncomingMessageWithDeny,
    res: ServerResponse,
    id: string
): Promise<void> {
    const { query } = parseQueryParams(req.url ?? `/tunnels/${id}`);
    const scopePassed = await runGatingHook("scope_tunnel", req, query, "delete");
    if (!scopePassed || req.denied) return;

    let deleted: Tunnel | null = null;
    await storage.transaction(async (tx) => {
        const existing = (await tx.get("tunnel", id, query)) as Tunnel;
        if (!existing) return;

        const gatePassed = await runGatingHook("delete_tunnel", req, existing);
        if (!gatePassed || req.denied) return;

        deleted = (await tx.remove("tunnel", id, query)) as Tunnel;
    });

    if (req.denied) return;
    if (!deleted) {
        sendJson(res, 404, { error: "Not Found" });
        return;
    }

    const item = deleted as Tunnel;
    await cacheDeleteEntity("tunnel", item.token, item.id);
    await severSessions({ tunnelId: id }, "tunnel_deleted");
    await runAwaitedHook("delete_tunnel_done", req, item);

    res.writeHead(204);
    res.end();
}

export async function handleTunnelRollToken(
    req: IncomingMessageWithDeny,
    res: ServerResponse,
    id: string
): Promise<void> {
    const { query } = parseQueryParams(req.url ?? `/tunnels/${id}/roll-token`);
    const scopePassed = await runGatingHook("scope_tunnel", req, query, "roll_token");
    if (!scopePassed || req.denied) return;

    let rolled: Tunnel | null = null;
    let oldToken = "";

    await storage.transaction(async (tx) => {
        const existing = (await tx.get("tunnel", id, query)) as Tunnel;
        if (!existing) return;
        oldToken = existing.token;

        const gatePassed = await runGatingHook("roll_token_tunnel", req, existing);
        if (!gatePassed || req.denied) return;

        const newToken = generateToken("tun_");
        rolled = (await tx.update("tunnel", id, { token: newToken }, query)) as Tunnel;
    });

    if (req.denied) return;
    if (!rolled) {
        sendJson(res, 404, { error: "Not Found" });
        return;
    }

    await cacheRollToken("tunnel", rolled, oldToken);
    await severSessions({ tunnelId: id }, "token_rolled");
    await runAwaitedHook("roll_token_tunnel_done", req, rolled);
    sendJson(res, 200, rolled);
}
