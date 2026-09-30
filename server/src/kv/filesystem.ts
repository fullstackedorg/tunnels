import fs from "node:fs";
import path from "node:path";
import type { KVProvider } from "./interface.ts";

interface StoredEntry {
    value: any;
    expiresAt: number | null;
}

interface KVData {
    entries: Record<string, StoredEntry>;
    sets: Record<string, string[]>;
}

function normalizeCompareValue(val: any): string {
    if (val === null || val === undefined) return "";
    if (typeof val === "string") return val;
    return JSON.stringify(val);
}

export class FileKVProvider implements KVProvider {
    private dataDir: string;
    private filePath: string;
    private lockPath: string;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.filePath = path.join(dataDir, "kv.json");
        this.lockPath = path.join(dataDir, "kv.lock");
        fs.mkdirSync(dataDir, { recursive: true });
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }

    private async acquireLock(): Promise<() => void> {
        const timeout = 10000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
            try {
                const fd = fs.openSync(
                    this.lockPath,
                    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
                );
                fs.closeSync(fd);
                return () => {
                    try {
                        if (fs.existsSync(this.lockPath)) {
                            fs.unlinkSync(this.lockPath);
                        }
                    } catch {
                        // ignore unlock failure
                    }
                };
            } catch {
                try {
                    const stat = fs.statSync(this.lockPath);
                    if (Date.now() - stat.mtimeMs > 5000) {
                        try {
                            fs.unlinkSync(this.lockPath);
                        } catch {
                            // race to break stale lock
                        }
                    }
                } catch {
                    // lock removed by another process
                }
                await this.sleep(10 + Math.floor(Math.random() * 20));
            }
        }
        throw new Error(`Timeout acquiring lock on ${this.lockPath}`);
    }

    private readData(): KVData {
        if (!fs.existsSync(this.filePath)) {
            return { entries: {}, sets: {} };
        }
        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const parsed = JSON.parse(raw);
            return {
                entries: parsed.entries || {},
                sets: parsed.sets || {},
            };
        } catch {
            return { entries: {}, sets: {} };
        }
    }

    private writeData(data: KVData): void {
        const now = Date.now();
        // Prune expired entries on write
        const cleanEntries: Record<string, StoredEntry> = {};
        for (const [k, v] of Object.entries(data.entries)) {
            if (!v.expiresAt || v.expiresAt > now) {
                cleanEntries[k] = v;
            }
        }
        data.entries = cleanEntries;

        const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
        fs.writeFileSync(tmpPath, JSON.stringify(data), "utf-8");
        fs.renameSync(tmpPath, this.filePath);
    }

    private isExpired(entry: StoredEntry): boolean {
        if (!entry.expiresAt) return false;
        return entry.expiresAt <= Date.now();
    }

    async get<T = any>(key: string): Promise<T | null> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            const entry = data.entries[key];
            if (!entry || this.isExpired(entry)) {
                return null;
            }
            return entry.value as T;
        } finally {
            unlock();
        }
    }

    async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
            data.entries[key] = { value, expiresAt };
            this.writeData(data);
        } finally {
            unlock();
        }
    }

    async setNX(key: string, value: any, ttlSeconds: number): Promise<boolean> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            const existing = data.entries[key];
            if (existing && !this.isExpired(existing)) {
                return false;
            }
            const expiresAt = Date.now() + ttlSeconds * 1000;
            data.entries[key] = { value, expiresAt };
            this.writeData(data);
            return true;
        } finally {
            unlock();
        }
    }

    async del(keys: string | string[]): Promise<void> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) {
                delete data.entries[k];
                delete data.sets[k];
            }
            this.writeData(data);
        } finally {
            unlock();
        }
    }

    async getdel<T = any>(key: string): Promise<T | null> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            const entry = data.entries[key];
            if (!entry) return null;
            delete data.entries[key];
            this.writeData(data);
            if (this.isExpired(entry)) {
                return null;
            }
            return entry.value as T;
        } finally {
            unlock();
        }
    }

    async delIfEquals(key: string, expected: any): Promise<boolean> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            const entry = data.entries[key];
            if (!entry || this.isExpired(entry)) {
                return false;
            }
            const curStr = normalizeCompareValue(entry.value);
            const expStr = normalizeCompareValue(expected);
            if (curStr === expStr) {
                delete data.entries[key];
                this.writeData(data);
                return true;
            }
            return false;
        } finally {
            unlock();
        }
    }

    async sadd(key: string, member: string): Promise<void> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            const current = data.sets[key] || [];
            if (!current.includes(member)) {
                current.push(member);
                data.sets[key] = current;
                this.writeData(data);
            }
        } finally {
            unlock();
        }
    }

    async srem(key: string, member: string): Promise<void> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            const current = data.sets[key] || [];
            const filtered = current.filter((m) => m !== member);
            if (filtered.length === 0) {
                delete data.sets[key];
            } else {
                data.sets[key] = filtered;
            }
            this.writeData(data);
        } finally {
            unlock();
        }
    }

    async smembers(key: string): Promise<string[]> {
        const unlock = await this.acquireLock();
        try {
            const data = this.readData();
            return [...(data.sets[key] || [])];
        } finally {
            unlock();
        }
    }

    async close(): Promise<void> {
        // Nothing persistent to close
    }
}
