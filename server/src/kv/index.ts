import { initRedis, getRedis, setRedis, delRedis } from "./redis";
import { getFileSystem, setFileSystem, delFileSystem } from "./filesystem";
import { logger } from "../utils/logger";

export enum KVType {
    FileSystem = "filesystem",
    Redis = "redis",
}

export const kvType = (await initRedis()) ? KVType.Redis : KVType.FileSystem;

logger.info("kv", `KV type [${kvType}]`);

export async function get<T = any>(key: string): Promise<T | null> {
    if (kvType === KVType.Redis) {
        return getRedis<T>(key);
    }
    return getFileSystem<T>(key);
}

export async function set(key: string, value: any): Promise<void> {
    if (kvType === KVType.Redis) {
        return setRedis(key, value);
    }
    return setFileSystem(key, value);
}

export async function del(key: string): Promise<void> {
    if (kvType === KVType.Redis) {
        return delRedis(key);
    }
    return delFileSystem(key);
}
