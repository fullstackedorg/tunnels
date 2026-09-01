import { initRedis, RedisKVProvider } from "./redis.ts";
import { FileSystemKVProvider } from "./filesystem.ts";
import { logger } from "../utils/logger.ts";
import type { KVProvider } from "./interface.ts";

export * from "./interface.ts";

export const KVType = {
    FileSystem: "filesystem",
    Redis: "redis",
} as const;
export type KVType = (typeof KVType)[keyof typeof KVType];

export const kvType = (await initRedis()) ? KVType.Redis : KVType.FileSystem;

logger.info("kv", `KV type [${kvType}]`);

const kvProvider: KVProvider =
    kvType === KVType.Redis
        ? new RedisKVProvider()
        : new FileSystemKVProvider();

export async function get<T = any>(key: string): Promise<T | null> {
    return kvProvider.get<T>(key);
}

export async function set(
    key: string,
    value: any,
    expiration?: number,
): Promise<void> {
    return kvProvider.set(key, value, expiration);
}

export async function del(key: string): Promise<void> {
    return kvProvider.del(key);
}
