import type { PgTableWithColumns } from "drizzle-orm/pg-core";
import crypto from "node:crypto";
import { initPostgreSQL, PostgreSQLStorageProvider } from "./postgresql.ts";
import { FileSystemStorageProvider } from "./filesystem.ts";
import { logger } from "../utils/logger.ts";
import type { StorageProvider, Item, WhereValue } from "./interface.ts";
import { getEnvOrArgCLI } from "../utils/args.ts";

export * from "./interface.ts";

export const StorageType = {
    FileSystem: "filesystem",
    PostgreSQL: "postgresql",
} as const;
export type StorageType = (typeof StorageType)[keyof typeof StorageType];

export const storageType = (await initPostgreSQL())
    ? StorageType.PostgreSQL
    : StorageType.FileSystem;

logger.info("storage", `Storage type [${storageType}]`);

const workers = getEnvOrArgCLI(["WORKERS", "workers", "w"], "number");
if (
    workers &&
    workers > 1 &&
    storageType === StorageType.FileSystem &&
    !getEnvOrArgCLI(["ALLOW_FILESYSTEM_MULTIWORKER"])
) {
    throw new Error(
        "Multi-worker mode is not supported with FileSystem storage. Use PostgreSQL to enable workers.",
    );
}

const storageProvider: StorageProvider =
    storageType === StorageType.PostgreSQL
        ? new PostgreSQLStorageProvider()
        : new FileSystemStorageProvider();

export async function list(table: PgTableWithColumns<any>) {
    return storageProvider.list(table);
}

export async function find(
    table: PgTableWithColumns<any>,
    where: WhereValue | WhereValue[],
) {
    return storageProvider.find(table, where);
}

// return ID of inserted item
export async function add(
    table: PgTableWithColumns<any>,
    item: Omit<Item, "id">,
) {
    return storageProvider.add(table, item);
}

export async function get(
    table: PgTableWithColumns<any>,
    id: crypto.UUID | number | string,
) {
    return storageProvider.get(table, id);
}

export async function update(
    table: PgTableWithColumns<any>,
    id: crypto.UUID | number,
    item: Partial<Item>,
) {
    return storageProvider.update(table, id, item);
}

export async function remove(
    table: PgTableWithColumns<any>,
    id: crypto.UUID | number,
) {
    return storageProvider.remove(table, id);
}
