import { createClient } from "redis";
import { getEnvOrArgCLI } from "../utils/args";
import { logger } from "../utils/logger";

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

export async function getRedis<T = any>(key: string): Promise<T | null> {
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

export async function setRedis(key: string, value: any): Promise<void> {
    if (!client) {
        throw new Error("Redis not initialized");
    }
    const serialized =
        typeof value === "string" ? value : JSON.stringify(value);
    await client.set(key, serialized);
}

export async function delRedis(key: string): Promise<void> {
    if (!client) {
        throw new Error("Redis not initialized");
    }
    await client.del(key);
}
