import type { IncomingMessage, ServerResponse } from "node:http";
import type { QueryContext, WhereCondition } from "../storage/interface.ts";
import type { Edge } from "../entities/schema.ts";
import { kv } from "../kv/index.ts";
import { isEdgeOnline } from "../warden/index.ts";

export async function readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1048576) {
                // 1MB limit for request payloads
                req.destroy();
                reject(new Error("Payload Too Large"));
            }
        });
        req.on("end", () => {
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

export function parseQueryParams(reqUrl: string): { query: QueryContext; error?: string } {
    const url = new URL(reqUrl, "http://localhost");
    const query: QueryContext = { where: [] };

    const limitStr = url.searchParams.get("limit");
    if (limitStr) query.limit = Math.min(1000, Math.max(0, parseInt(limitStr, 10) || 100));

    const offsetStr = url.searchParams.get("offset");
    if (offsetStr) query.offset = Math.max(0, parseInt(offsetStr, 10) || 0);

    const orderByStr = url.searchParams.get("orderBy");
    if (orderByStr) {
        const [col, dir] = orderByStr.split(":");
        query.orderBy = {
            column: col || "id",
            direction: dir === "desc" ? "desc" : "asc",
        };
    }

    for (const [key, val] of url.searchParams.entries()) {
        if (key === "limit" || key === "offset" || key === "orderBy") continue;

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
