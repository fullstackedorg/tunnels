import { createClient } from "redis";
import { getEnvOrArgCLI } from "../utils/args.ts";
import { logger } from "../utils/logger.ts";
import type { KVProvider } from "./interface.ts";

type RedisClientType = ReturnType<typeof createClient>;
let client: RedisClientType | null = null;

export async function initRedis(): Promise<boolean> {
    const config = getEnvOrArgCLI(["REDIS_URL", "redis-url"], "string");

    if (!config) {
        return false;
    }

    try {
        client = createClient({ url: config });
        client.on("error", (err) => logger.error("KV.Redis", String(err)));
        await client.connect();
        await client.ping();
        return true;
    } catch (error) {
        logger.error("KV.Redis", `Failed to connect to Redis: ${error}`);
        if (client) {
            try {
                await client.disconnect();
            } catch {}
            client = null;
        }
        return false;
    }
}

async function getRedis<T = any>(key: string): Promise<T | null> {
    if (!client) {
        throw new Error("Redis not initialized");
    }
    const val = await client.get(key);
    if (val === null) {
        return null;
    }
    try {
        return JSON.parse(val) as T;
    } catch {
        return val as unknown as T;
    }
}

async function setRedis(
    key: string,
    value: any,
    expiration?: number,
): Promise<void> {
    if (!client) {
        throw new Error("Redis not initialized");
    }
    const serialized =
        typeof value === "string" ? value : JSON.stringify(value);
    if (expiration && expiration > 0) {
        await client.set(key, serialized, { EX: expiration });
    } else {
        await client.set(key, serialized);
    }
}

async function delRedis(key: string): Promise<void> {
    if (!client) {
        throw new Error("Redis not initialized");
    }
    await client.del(key);
}

export class RedisKVProvider implements KVProvider {
    async get<T = any>(key: string): Promise<T | null> {
        return getRedis<T>(key);
    }

    async set(key: string, value: any, expiration?: number): Promise<void> {
        return setRedis(key, value, expiration);
    }

    async del(key: string): Promise<void> {
        return delRedis(key);
    }
}
