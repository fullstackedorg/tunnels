import { createClient, type RedisClientType } from "redis";
import type { KVProvider } from "./interface.ts";

function serializeValue(val: any): string {
    if (typeof val === "string") {
        return val;
    }
    return JSON.stringify(val);
}

function deserializeValue<T>(raw: string | null): T | null {
    if (raw === null || raw === undefined) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return raw as unknown as T;
    }
}

export class RedisKVProvider implements KVProvider {
    private client: RedisClientType;
    private isConnected = false;

    constructor(redisUrl: string) {
        this.client = createClient({ url: redisUrl });
    }

    private async ensureConnected(): Promise<void> {
        if (!this.isConnected) {
            await this.client.connect();
            this.isConnected = true;
        }
    }

    async get<T = any>(key: string): Promise<T | null> {
        await this.ensureConnected();
        const raw = await this.client.get(key);
        return deserializeValue<T>(raw);
    }

    async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
        await this.ensureConnected();
        const valStr = serializeValue(value);
        if (ttlSeconds && ttlSeconds > 0) {
            await this.client.set(key, valStr, { EX: ttlSeconds });
        } else {
            await this.client.set(key, valStr);
        }
    }

    async setNX(key: string, value: any, ttlSeconds: number): Promise<boolean> {
        await this.ensureConnected();
        const valStr = serializeValue(value);
        const res = await this.client.set(key, valStr, {
            NX: true,
            EX: ttlSeconds,
        });
        return res === "OK";
    }

    async del(keys: string | string[]): Promise<void> {
        await this.ensureConnected();
        const list = Array.isArray(keys) ? keys : [keys];
        if (list.length === 0) return;
        await this.client.del(list);
    }

    async getdel<T = any>(key: string): Promise<T | null> {
        await this.ensureConnected();
        const raw = await this.client.getDel(key);
        return deserializeValue<T>(raw);
    }

    async delIfEquals(key: string, expected: any): Promise<boolean> {
        await this.ensureConnected();
        const expStr = serializeValue(expected);
        const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
        const res = await this.client.eval(script, {
            keys: [key],
            arguments: [expStr],
        });
        return res === 1;
    }

    async sadd(key: string, member: string): Promise<void> {
        await this.ensureConnected();
        await this.client.sAdd(key, member);
    }

    async srem(key: string, member: string): Promise<void> {
        await this.ensureConnected();
        await this.client.sRem(key, member);
    }

    async smembers(key: string): Promise<string[]> {
        await this.ensureConnected();
        return await this.client.sMembers(key);
    }

    async close(): Promise<void> {
        if (this.isConnected) {
            await this.client.quit();
            this.isConnected = false;
        }
    }
}
