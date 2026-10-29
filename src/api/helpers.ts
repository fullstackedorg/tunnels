import type { IncomingMessage, ServerResponse } from "node:http";
import type { EntityName, QueryContext } from "../storage/interface.ts";
import type { Edge } from "../entities/schema.ts";
import { kv } from "../kv/index.ts";
import { isEdgeOnline } from "../warden/index.ts";

const MAX_BODY_BYTES = 1048576;

export async function readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = "";
        let tooLarge = false;
        req.on("data", (chunk) => {
            if (tooLarge) return; // keep draining so the 413 response can be delivered
            body += chunk;
            if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
                tooLarge = true;
                body = "";
                const err: any = new Error("Payload Too Large");
                err.statusCode = 413;
                reject(err);
            }
        });
        req.on("end", () => {
            if (tooLarge) return;
            if (!body.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(body));
            } catch {
                const err: any = new Error("Malformed JSON");
                err.statusCode = 400;
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

const COLUMNS: Record<EntityName, Set<string>> = {
    edge: new Set(["id", "token", "name", "version"]),
    tunnel: new Set(["id", "token", "name", "internalHost", "internalPort", "edgeId"]),
};

function isKnownColumn(entity: EntityName, column: string): boolean {
    return COLUMNS[entity].has(column) || /^metadata\.[^.]+$/.test(column);
}

export function parseQueryParams(
    reqUrl: string,
    entity: EntityName
): { query: QueryContext; error?: string } {
    const url = new URL(reqUrl, "http://localhost");
    const query: QueryContext = { where: [], orderBy: { column: "id", direction: "asc" } };

    const limitStr = url.searchParams.get("limit");
    if (limitStr) query.limit = Math.min(1000, Math.max(0, parseInt(limitStr, 10) || 100));

    const offsetStr = url.searchParams.get("offset");
    if (offsetStr) query.offset = Math.max(0, parseInt(offsetStr, 10) || 0);

    const orderByStr = url.searchParams.get("orderBy");
    if (orderByStr) {
        const [col, dir] = orderByStr.split(":");
        const column = col || "id";
        if (!COLUMNS[entity].has(column)) {
            return { query, error: `Unknown sort column: ${column}` };
        }
        query.orderBy = { column, direction: dir === "desc" ? "desc" : "asc" };
    }

    for (const [key, val] of url.searchParams.entries()) {
        if (key === "limit" || key === "offset" || key === "orderBy") continue;
        if (!isKnownColumn(entity, key)) {
            return { query, error: `Unknown filter column: ${key}` };
        }

        if (key === "internalPort") {
            const num = Number(val);
            if (Number.isNaN(num) || !Number.isInteger(num)) {
                return { query, error: "Invalid internalPort filter value" };
            }
            query.where!.push({ column: key, operator: "eq", value: num });
        } else {
            query.where!.push({ column: key, operator: "eq", value: val });
        }
    }

    return { query };
}

export function sendJson(
    res: ServerResponse,
    statusCode: number,
    data: any,
    headers?: Record<string, any>
): void {
    const body = data !== undefined ? JSON.stringify(data) : "";
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body, "utf-8"),
        ...(headers || {}),
    });
    res.end(body);
}

export async function enrichEdgePresence(edge: Edge): Promise<Edge> {
    const connected = await isEdgeOnline(edge.id);
    const lastSeen = await kv.get<number>(`edge:${edge.id}:last_seen`);
    return {
        ...edge,
        connected,
        lastSeen: lastSeen !== null ? Number(lastSeen) : null,
    };
}
