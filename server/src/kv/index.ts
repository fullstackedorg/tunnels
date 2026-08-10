import { initRedis, RedisKVProvider } from "./redis";
import { FileSystemKVProvider } from "./filesystem";
import { logger } from "../utils/logger";
import { KVProvider } from "./interface";

export * from "./interface";

export enum KVType {
    FileSystem = "filesystem",
    Redis = "redis",
}

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
