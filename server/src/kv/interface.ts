export interface KVProvider {
    get<T = any>(key: string): Promise<T | null>;
    set(key: string, value: any, expiration?: number): Promise<void>;
    del(key: string): Promise<void>;
}
