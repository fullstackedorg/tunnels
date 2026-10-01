import type { ServerResponse } from "node:http";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Edge, Tunnel } from "../entities/schema.ts";
import { storage } from "../storage/index.ts";
import { generateToken } from "../utils/token.ts";
import { validateEntityPayload } from "../entities/validation.ts";
import { cacheUpdateEntity, cacheRollToken, cacheDeleteEntity } from "../entities/cache.ts";
import { runGatingHook, runPostQueryHook, runAwaitedHook } from "../utils/hooks.ts";
import { kv } from "../kv/index.ts";
import { closeLifeline } from "../warden/index.ts";
import { severSessions } from "../tunnels/registry.ts";
import { isConflictError } from "../utils/errors.ts";
import { readJsonBody, parseQueryParams, sendJson, enrichEdgePresence } from "./helpers.ts";

export async function handleEdgesList(
    req: IncomingMessageWithDeny,
    res: ServerResponse
): Promise<void> {
    const { query, error } = parseQueryParams(req.url ?? "/edges", "edge");
    if (error) {
        sendJson(res, 400, { error });
        return;
    }

    const scopePassed = await runGatingHook("scope_edge", req, query, "list");
    if (!scopePassed || req.denied) return;

    const { items, total } = await storage.list("edge", query);
    const enriched = await Promise.all(items.map((e) => enrichEdgePresence(e as Edge)));

    await runPostQueryHook("list_edge_done", req, enriched);
    if (req.denied) return;

    sendJson(res, 200, enriched, { "X-Total-Count": String(total) });
}

export async function handleEdgeCreate(
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

    const v1 = validateEntityPayload("edge", payload, false);
    if (!v1.valid) {
        sendJson(res, 400, { error: v1.error, fields: v1.fields });
        return;
    }

    const gatePassed = await runGatingHook("create_edge", req, payload);
    if (!gatePassed || req.denied) return;

    const v2 = validateEntityPayload("edge", payload, false);
    if (!v2.valid) {
        throw new Error(`create hook introduced invalid fields: ${JSON.stringify(v2.fields)}`);
    }

    const token = generateToken("edg_");
    let item: any;
    try {
        item = await storage.transaction(async (tx) => {
            return await tx.add("edge", {
                ...payload,
                token,
                version: null,
                metadata: payload.metadata || {},
            });
        });
    } catch (err: any) {
        if (!isConflictError(err)) throw err;
        sendJson(res, 409, { error: "Conflict" });
        return;
    }

    await cacheUpdateEntity("edge", item as Edge);
    await runAwaitedHook("create_edge_done", req, item);
    sendJson(res, 201, item);
}

export async function handleEdgeGet(
    req: IncomingMessageWithDeny,
    res: ServerResponse,
    id: string
): Promise<void> {
    const { query, error } = parseQueryParams(req.url ?? `/edges/${id}`, "edge");
    if (error) {
        sendJson(res, 400, { error });
        return;
    }
    const scopePassed = await runGatingHook("scope_edge", req, query, "read");
    if (!scopePassed || req.denied) return;

    const item = await storage.get("edge", id, query);
    if (!item) {
        sendJson(res, 404, { error: "Not Found" });
        return;
    }

    const enriched = await enrichEdgePresence(item as Edge);
    await runPostQueryHook("read_edge_done", req, enriched);
    if (req.denied) return;

    sendJson(res, 200, enriched);
}

export async function handleEdgeUpdate(
    req: IncomingMessageWithDeny,
    res: ServerResponse,
    id: string
): Promise<void> {
    const { query, error } = parseQueryParams(req.url ?? `/edges/${id}`, "edge");
    if (error) {
        sendJson(res, 400, { error });
        return;
    }
    const scopePassed = await runGatingHook("scope_edge", req, query, "update");
    if (!scopePassed || req.denied) return;

    let updates: any;
    try {
        updates = await readJsonBody(req);
    } catch (err: any) {
        sendJson(res, err.statusCode || 400, { error: err.message });
        return;
    }

    const v1 = validateEntityPayload("edge", updates, true);
    if (!v1.valid) {
        sendJson(res, 400, { error: v1.error, fields: v1.fields });
        return;
    }

    let updated: Edge | null = null;
    try {
        await storage.transaction(async (tx) => {
            const existing = (await tx.get("edge", id, query)) as Edge;
            if (!existing) return;

            const gatePassed = await runGatingHook("update_edge", req, existing, updates);
            if (!gatePassed || req.denied) return;

            const v2 = validateEntityPayload("edge", updates, true);
            if (!v2.valid) {
                throw new Error("Hook introduced invalid fields: " + JSON.stringify(v2.fields));
            }

            updated = (await tx.update("edge", id, updates, query)) as Edge;
        });
    } catch (err: any) {
        if (!isConflictError(err)) throw err;
        sendJson(res, 409, { error: "Conflict" });
        return;
    }

    if (req.denied) return;
    if (!updated) {
        sendJson(res, 404, { error: "Not Found" });
        return;
    }

    await cacheUpdateEntity("edge", updated);
    await runAwaitedHook("update_edge_done", req, updated);
    sendJson(res, 200, updated);
}

export async function handleEdgeDelete(
    req: IncomingMessageWithDeny,
    res: ServerResponse,
    id: string
): Promise<void> {
    const { query, error } = parseQueryParams(req.url ?? `/edges/${id}`, "edge");
    if (error) {
        sendJson(res, 400, { error });
        return;
    }
    const scopePassed = await runGatingHook("scope_edge", req, query, "delete");
    if (!scopePassed || req.denied) return;

    let deletedEdge: Edge | null = null;
    let childTunnels: Tunnel[] = [];

    try {
        await storage.transaction(async (tx) => {
            const edge = (await tx.get("edge", id, query)) as Edge;
            if (!edge) return;

            const gatePassed = await runGatingHook("delete_edge", req, edge);
            if (!gatePassed || req.denied) return;

            childTunnels = (await tx.find("tunnel", [
                { column: "edgeId", operator: "eq", value: id },
            ])) as Tunnel[];

            for (const child of childTunnels) {
                const childGate = await runGatingHook("delete_tunnel", req, child);
                if (!childGate || req.denied) {
                    throw new Error("CHILD_HOOK_DENIED");
                }
            }

            deletedEdge = (await tx.remove("edge", id, query)) as Edge;
        });
    } catch (err: any) {
        if (err.message === "CHILD_HOOK_DENIED") {
            if (!req.denied) req.deny();
            return;
        }
        throw err;
    }

    if (req.denied) return;
    if (!deletedEdge) {
        sendJson(res, 404, { error: "Not Found" });
        return;
    }

    const edge = deletedEdge as Edge;
    await cacheDeleteEntity("edge", edge.token);
    for (const child of childTunnels) {
        await cacheDeleteEntity("tunnel", child.token);
    }

    // closeLifeline reads edge:<id>:worker to reach the lifeline worker, so evict presence after.
    await closeLifeline(edge.id, "edge_deleted");
    await kv.del([`edge:${edge.id}:worker`, `edge:${edge.id}:last_seen`]);
    await severSessions({ edgeId: edge.id }, "edge_deleted");

    for (const child of childTunnels) {
        await runAwaitedHook("delete_tunnel_done", req, child);
    }
    await runAwaitedHook("delete_edge_done", req, edge);

    res.writeHead(204);
    res.end();
}

export async function handleEdgeRollToken(
    req: IncomingMessageWithDeny,
    res: ServerResponse,
    id: string
): Promise<void> {
    const { query, error } = parseQueryParams(req.url ?? `/edges/${id}/roll-token`, "edge");
    if (error) {
        sendJson(res, 400, { error });
        return;
    }
    const scopePassed = await runGatingHook("scope_edge", req, query, "roll_token");
    if (!scopePassed || req.denied) return;

    let rolled: Edge | null = null;
    let oldToken = "";

    await storage.transaction(async (tx) => {
        const existing = (await tx.get("edge", id, query)) as Edge;
        if (!existing) return;
        oldToken = existing.token;

        const gatePassed = await runGatingHook("roll_token_edge", req, existing);
        if (!gatePassed || req.denied) return;

        const newToken = generateToken("edg_");
        rolled = (await tx.update("edge", id, { token: newToken }, query)) as Edge;
    });

    if (req.denied) return;
    if (!rolled) {
        sendJson(res, 404, { error: "Not Found" });
        return;
    }

    await cacheRollToken("edge", rolled, oldToken);
    await closeLifeline(id, "token_rolled");
    await severSessions({ edgeId: id }, "token_rolled");
    await runAwaitedHook("roll_token_edge_done", req, rolled);
    sendJson(res, 200, rolled);
}
