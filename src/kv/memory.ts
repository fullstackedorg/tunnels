import type { KVProvider } from "./interface.ts";

interface MemoryEntry {
    value: any;
    expiresAt?: number;
}

function normalizeCompareValue(val: any): string {
    if (val === null || val === undefined) return "";
    if (typeof val === "string") return val;
    return JSON.stringify(val);
}

export class MemoryKVProvider implements KVProvider {
    private entries = new Map<string, MemoryEntry>();
    private sets = new Map<string, Set<string>>();
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.sweepTimer = setInterval(() => this.sweep(), 1000);
        this.sweepTimer.unref();
    }

    private sweep(): void {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt && entry.expiresAt <= now) {
                this.entries.delete(key);
            }
        }
    }

    private isExpired(entry: MemoryEntry): boolean {
        if (!entry.expiresAt) return false;
        return entry.expiresAt <= Date.now();
    }

    private clone<T>(val: T): T {
        if (val === undefined || val === null || typeof val !== "object") {
            return val;
        }
        try {
            return structuredClone(val);
        } catch {
            return JSON.parse(JSON.stringify(val));
        }
    }

    async get<T = any>(key: string): Promise<T | null> {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (this.isExpired(entry)) {
            this.entries.delete(key);
            return null;
        }
        return this.clone(entry.value);
    }

    async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
        const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
        this.entries.set(key, { value: this.clone(value), expiresAt });
    }

    async setNX(key: string, value: any, ttlSeconds: number): Promise<boolean> {
        const existing = this.entries.get(key);
        if (existing && !this.isExpired(existing)) {
            return false;
        }
        const expiresAt = Date.now() + ttlSeconds * 1000;
        this.entries.set(key, { value: this.clone(value), expiresAt });
        return true;
    }

    async del(keys: string | string[]): Promise<void> {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const k of list) {
            this.entries.delete(k);
            this.sets.delete(k);
        }
    }

    async getdel<T = any>(key: string): Promise<T | null> {
        const entry = this.entries.get(key);
        if (!entry) return null;
        this.entries.delete(key);
        if (this.isExpired(entry)) {
            return null;
        }
        return this.clone(entry.value);
    }

    async delIfEquals(key: string, expected: any): Promise<boolean> {
        const entry = this.entries.get(key);
        if (!entry || this.isExpired(entry)) {
            return false;
        }
        const currentStr = normalizeCompareValue(entry.value);
        const expectedStr = normalizeCompareValue(expected);
        if (currentStr === expectedStr) {
            this.entries.delete(key);
            return true;
        }
        return false;
    }

    async sadd(key: string, member: string): Promise<void> {
        let set = this.sets.get(key);
        if (!set) {
            set = new Set<string>();
            this.sets.set(key, set);
        }
        set.add(member);
    }

    async srem(key: string, member: string): Promise<void> {
        const set = this.sets.get(key);
        if (set) {
            set.delete(member);
            if (set.size === 0) {
                this.sets.delete(key);
            }
        }
    }

    async smembers(key: string): Promise<string[]> {
        const set = this.sets.get(key);
        return set ? Array.from(set) : [];
    }

    async close(): Promise<void> {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        this.entries.clear();
        this.sets.clear();
    }
}
