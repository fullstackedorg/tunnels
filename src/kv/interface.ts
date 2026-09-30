export interface KVProvider {
    get<T = any>(key: string): Promise<T | null>;
    /** ttlSeconds omitted = no expiry. */
    set(key: string, value: any, ttlSeconds?: number): Promise<void>;
    /** Sets only if the key does not exist. Returns true if written. */
    setNX(key: string, value: any, ttlSeconds: number): Promise<boolean>;
    /** Deletes one or more keys. An empty array is a no-op. */
    del(keys: string | string[]): Promise<void>;
    /** Atomically reads and deletes. */
    getdel<T = any>(key: string): Promise<T | null>;
    /** Atomically deletes the key only if its value equals expected. */
    delIfEquals(key: string, expected: any): Promise<boolean>;
    sadd(key: string, member: string): Promise<void>;
    srem(key: string, member: string): Promise<void>;
    smembers(key: string): Promise<string[]>;
    close(): Promise<void>;
}
