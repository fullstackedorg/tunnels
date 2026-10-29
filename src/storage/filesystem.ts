import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
    EntityName,
    Item,
    QueryContext,
    StorageProvider,
    WhereCondition,
} from "./interface.ts";
import { filterItems, sortAndPaginate } from "./query.ts";

interface StoreData {
    edge: Item[];
    tunnel: Item[];
}

export class FilesystemStorageProvider implements StorageProvider {
    private dataDir: string;
    private filePath: string;
    private lockPath: string;
    private sharedMode: boolean;
    private data: StoreData = { edge: [], tunnel: [] };
    private flushTimer: NodeJS.Timeout | null = null;
    private dirty = false;
    private lastMtime = 0;
    private lastSize = -1;

    constructor(dataDir: string, sharedMode = false) {
        this.dataDir = dataDir;
        this.filePath = path.join(dataDir, "store.json");
        this.lockPath = path.join(dataDir, "store.lock");
        this.sharedMode = sharedMode;
        fs.mkdirSync(dataDir, { recursive: true });
        this.loadInitial();
    }

    private async sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }

    private lockCount = 0;
    private unlockFn: (() => void) | null = null;

    private async acquireLock(): Promise<() => void> {
        if (this.lockCount > 0) {
            this.lockCount++;
            return () => {
                this.lockCount--;
                if (this.lockCount === 0 && this.unlockFn) {
                    this.unlockFn();
                    this.unlockFn = null;
                }
            };
        }
        const timeout = 10000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const fd = fs.openSync(
                    this.lockPath,
                    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
                );
                fs.closeSync(fd);
                this.lockCount = 1;
                this.unlockFn = () => {
                    try {
                        if (fs.existsSync(this.lockPath)) fs.unlinkSync(this.lockPath);
                    } catch {}
                };
                return () => {
                    this.lockCount--;
                    if (this.lockCount === 0 && this.unlockFn) {
                        this.unlockFn();
                        this.unlockFn = null;
                    }
                };
            } catch {
                try {
                    const stat = fs.statSync(this.lockPath);
                    if (Date.now() - stat.mtimeMs > 5000) {
                        try {
                            fs.unlinkSync(this.lockPath);
                        } catch {}
                    }
                } catch {}
                await this.sleep(10 + Math.floor(Math.random() * 20));
            }
        }
        throw new Error(`Timeout acquiring lock on ${this.lockPath}`);
    }

    private loadInitial(): void {
        if (!fs.existsSync(this.filePath)) {
            this.data = { edge: [], tunnel: [] };
            this.writeAtomic(this.data);
            return;
        }
        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const stat = fs.statSync(this.filePath);
            this.lastMtime = stat.mtimeMs;
            this.lastSize = stat.size;
            this.data = JSON.parse(raw);
        } catch {
            this.data = { edge: [], tunnel: [] };
        }
    }

    private reloadIfChanged(): void {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const stat = fs.statSync(this.filePath);
            if (stat.mtimeMs !== this.lastMtime || stat.size !== this.lastSize) {
                const raw = fs.readFileSync(this.filePath, "utf-8");
                this.data = JSON.parse(raw);
                this.lastMtime = stat.mtimeMs;
                this.lastSize = stat.size;
            }
        } catch {}
    }

    private writeAtomic(data: StoreData): void {
        const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
        fs.renameSync(tmp, this.filePath);
        try {
            const stat = fs.statSync(this.filePath);
            this.lastMtime = stat.mtimeMs;
            this.lastSize = stat.size;
        } catch {}
    }

    private scheduleFlush(): void {
        if (this.sharedMode) {
            this.writeAtomic(this.data);
            return;
        }
        this.dirty = true;
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                if (this.dirty) {
                    this.writeAtomic(this.data);
                    this.dirty = false;
                }
            }, 5000);
            this.flushTimer.unref();
        }
    }

    private mergeMetadata(stored: any, updates: any): Record<string, any> {
        if (updates === null) return {};
        if (typeof updates !== "object") return stored || {};
        const merged = { ...(stored || {}), ...updates };
        for (const [k, v] of Object.entries(updates)) {
            if (v === null) delete merged[k];
        }
        return merged;
    }

    private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
        if (!this.sharedMode) return fn();
        const unlock = await this.acquireLock();
        try {
            this.reloadIfChanged();
            return await fn();
        } finally {
            unlock();
        }
    }

    async list(
        entity: EntityName,
        query?: QueryContext
    ): Promise<{ items: Item[]; total: number }> {
        return this.withLock(() => {
            const filtered = filterItems(this.data[entity], query?.where);
            return sortAndPaginate(filtered, query);
        });
    }

    async find(entity: EntityName, where: WhereCondition[]): Promise<Item[]> {
        return this.withLock(() => {
            return filterItems(this.data[entity], where);
        });
    }

    async get(entity: EntityName, id: string, query?: QueryContext): Promise<Item | null> {
        return this.withLock(() => {
            const item = this.data[entity].find((x) => x.id === id);
            if (!item) return null;
            if (query?.where && !filterItems([item], query.where).length) return null;
            return { ...item };
        });
    }

    async getByToken(entity: EntityName, token: string): Promise<Item | null> {
        return this.withLock(() => {
            const item = this.data[entity].find((x) => x.token === token);
            return item ? { ...item } : null;
        });
    }

    async add(entity: EntityName, item: Omit<Item, "id">): Promise<Item> {
        return this.withLock(() => {
            if (item.token && this.data[entity].some((x) => x.token === item.token)) {
                throw new Error(`Conflict: Token already exists for ${entity}`);
            }
            const id = (item as any).id || crypto.randomUUID();
            const newItem: Item = { ...item, id, metadata: item.metadata || {} };
            this.data[entity].push(newItem);
            this.scheduleFlush();
            return { ...newItem };
        });
    }

    async update(
        entity: EntityName,
        id: string,
        changes: Partial<Item>,
        query?: QueryContext
    ): Promise<Item | null> {
        return this.withLock(() => {
            const idx = this.data[entity].findIndex((x) => x.id === id);
            if (idx === -1) return null;
            const current = this.data[entity][idx];
            if (query?.where && !filterItems([current], query.where).length) return null;

            if (changes.token && changes.token !== current.token) {
                if (this.data[entity].some((x) => x.token === changes.token)) {
                    throw new Error(`Conflict: Token already exists for ${entity}`);
                }
            }

            const updated: Item = { ...current, ...changes };
            if ("metadata" in changes) {
                updated.metadata = this.mergeMetadata(current.metadata, changes.metadata);
            }
            this.data[entity][idx] = updated;
            this.scheduleFlush();
            return { ...updated };
        });
    }

    async remove(entity: EntityName, id: string, query?: QueryContext): Promise<Item | null> {
        return this.withLock(() => {
            const idx = this.data[entity].findIndex((x) => x.id === id);
            if (idx === -1) return null;
            const current = this.data[entity][idx];
            if (query?.where && !filterItems([current], query.where).length) return null;

            this.data[entity].splice(idx, 1);
            if (entity === "edge") {
                this.data.tunnel = this.data.tunnel.filter((t) => t.edgeId !== id);
            }
            this.scheduleFlush();
            return { ...current };
        });
    }

    async transaction<T>(fn: (tx: StorageProvider) => Promise<T>): Promise<T> {
        if (!this.sharedMode) {
            const backup = JSON.stringify(this.data);
            try {
                return await fn(this);
            } catch (err) {
                this.data = JSON.parse(backup);
                this.scheduleFlush();
                throw err;
            }
        }
        const unlock = await this.acquireLock();
        try {
            this.reloadIfChanged();
            const backup = JSON.stringify(this.data);
            try {
                const res = await fn(this);
                this.writeAtomic(this.data);
                return res;
            } catch (err) {
                this.data = JSON.parse(backup);
                throw err;
            }
        } finally {
            unlock();
        }
    }

    async close(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.dirty) {
            this.writeAtomic(this.data);
            this.dirty = false;
        }
    }
}
