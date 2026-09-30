import { kv } from "../kv/index.ts";
import { storage } from "../storage/index.ts";
import type { EntityName } from "../storage/interface.ts";
import type { Edge, Tunnel } from "./schema.ts";
import { DEFAULT_ENTITY_CACHE_TTL, DEFAULT_NEGATIVE_CACHE_TTL } from "../constants.ts";

export class ServiceUnavailableError extends Error {
    readonly statusCode = 503;
    constructor(message = "Service Unavailable") {
        super(message);
        this.name = "ServiceUnavailableError";
    }
}

export interface ResolveTokenResult {
    type: EntityName;
    entity: Edge | Tunnel;
}

let entityCacheTtl = DEFAULT_ENTITY_CACHE_TTL;
let negativeCacheTtl = DEFAULT_NEGATIVE_CACHE_TTL;

export function setCacheTtl(entityTtl: number, negativeTtl: number): void {
    entityCacheTtl = entityTtl;
    negativeCacheTtl = negativeTtl;
}

export async function resolveToken(token: string): Promise<ResolveTokenResult | null> {
    if (!token) return null;

    let entityType: EntityName;
    if (token.startsWith("tun_")) {
        entityType = "tunnel";
    } else if (token.startsWith("edg_")) {
        entityType = "edge";
    } else {
        return null;
    }

    try {
        // 1. Check negative cache
        const isMiss = await kv.get(`entity:miss:${token}`);
        if (isMiss !== null) {
            return null;
        }

        // 2. Check positive cache
        const cached = await kv.get<any>(`entity:${entityType}:${token}`);
        if (cached) {
            return { type: entityType, entity: cached };
        }

        // 3. Fallback to storage
        const item = await storage.getByToken(entityType, token);
        if (!item) {
            await kv.set(`entity:miss:${token}`, 1, negativeCacheTtl);
            return null;
        }

        // 4. Populate positive cache
        await kv.setNX(`entity:${entityType}:${token}`, item, entityCacheTtl);
        await kv.setNX(`entity:${entityType}:${item.id}`, item, entityCacheTtl);

        return { type: entityType, entity: item as any };
    } catch (err) {
        if (err instanceof ServiceUnavailableError) throw err;
        throw new ServiceUnavailableError(
            `Storage or KV error resolving token: ${(err as any)?.message}`
        );
    }
}

export async function cacheUpdateEntity(
    entityType: EntityName,
    entity: Edge | Tunnel
): Promise<void> {
    try {
        await kv.set(`entity:${entityType}:${entity.token}`, entity, entityCacheTtl);
        await kv.set(`entity:${entityType}:${entity.id}`, entity, entityCacheTtl);
    } catch {
        // fail-open on cache updates, storage is source of truth
    }
}

export async function cacheRollToken(
    entityType: EntityName,
    entity: Edge | Tunnel,
    oldToken: string
): Promise<void> {
    try {
        await kv.set(`entity:${entityType}:${entity.token}`, entity, entityCacheTtl);
        await kv.set(`entity:${entityType}:${entity.id}`, entity, entityCacheTtl);
        await kv.del(`entity:${entityType}:${oldToken}`);
        await kv.set(`entity:miss:${oldToken}`, 1, negativeCacheTtl);
    } catch {
        // fail-open
    }
}

export async function cacheDeleteEntity(
    entityType: EntityName,
    token: string,
    id?: string
): Promise<void> {
    try {
        const keysToDelete = [`entity:${entityType}:${token}`];
        if (id) keysToDelete.push(`entity:${entityType}:${id}`);
        await kv.del(keysToDelete);
        await kv.set(`entity:miss:${token}`, 1, negativeCacheTtl);
    } catch {
        // fail-open
    }
}
