import type { AppConfig } from "../utils/config.ts";
import type { KVProvider } from "./interface.ts";
import { MemoryKVProvider } from "./memory.ts";
import { FileKVProvider } from "./filesystem.ts";
import { RedisKVProvider } from "./redis.ts";

export type { KVProvider } from "./interface.ts";

let activeKV: KVProvider | null = null;

export function createKVProvider(config: AppConfig): KVProvider {
    if (config.redisUrl) {
        return new RedisKVProvider(config.redisUrl);
    }
    if (config.workers > 1 && config.allowFsMultiworker) {
        return new FileKVProvider(config.dataDir);
    }
    return new MemoryKVProvider();
}

export function initKV(config: AppConfig): KVProvider {
    if (activeKV) {
        return activeKV;
    }
    activeKV = createKVProvider(config);
    return activeKV;
}

export function setKV(provider: KVProvider | null): void {
    activeKV = provider;
}

export const kv: KVProvider = new Proxy({} as KVProvider, {
    get(_target, prop: keyof KVProvider) {
        if (!activeKV) {
            activeKV = new MemoryKVProvider();
        }
        const val = activeKV[prop];
        if (typeof val === "function") {
            return val.bind(activeKV);
        }
        return val;
    },
});

export async function closeKV(): Promise<void> {
    if (activeKV) {
        await activeKV.close();
        activeKV = null;
    }
}
