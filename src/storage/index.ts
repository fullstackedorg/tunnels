import type { AppConfig } from "../utils/config.ts";
import type { StorageProvider } from "./interface.ts";
import { FilesystemStorageProvider } from "./filesystem.ts";
import { PostgreSQLStorageProvider } from "./postgresql.ts";

export type {
    EntityName,
    Item,
    WhereOperator,
    WhereCondition,
    QueryContext,
    StorageProvider,
} from "./interface.ts";

let activeStorage: StorageProvider | null = null;

export async function createStorageProvider(config: AppConfig): Promise<StorageProvider> {
    if (config.postgresUrl) {
        const pgProvider = new PostgreSQLStorageProvider(config.postgresUrl);
        await pgProvider.init();
        return pgProvider;
    }
    const sharedMode = Boolean(config.workers > 1 && config.allowFsMultiworker);
    return new FilesystemStorageProvider(config.dataDir, sharedMode);
}

export async function initStorage(config: AppConfig): Promise<StorageProvider> {
    if (activeStorage) {
        return activeStorage;
    }
    activeStorage = await createStorageProvider(config);
    return activeStorage;
}

export function setStorage(provider: StorageProvider | null): void {
    activeStorage = provider;
}

export const storage: StorageProvider = new Proxy({} as StorageProvider, {
    get(_target, prop: keyof StorageProvider) {
        if (!activeStorage) {
            activeStorage = new FilesystemStorageProvider("data", false);
        }
        const val = activeStorage[prop];
        if (typeof val === "function") {
            return val.bind(activeStorage);
        }
        return val;
    },
});

export async function closeStorage(): Promise<void> {
    if (activeStorage) {
        await activeStorage.close();
        activeStorage = null;
    }
}
