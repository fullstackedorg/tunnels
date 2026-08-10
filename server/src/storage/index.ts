import { PgTableWithColumns } from "drizzle-orm/pg-core";
import crypto from "node:crypto";
import { initPostgreSQL, PostgreSQLStorageProvider } from "./postgresql";
import { FileSystemStorageProvider } from "./filesystem";
import { logger } from "../utils/logger";
import { StorageProvider, Item, WhereValue } from "./interface";

export * from "./interface";

export enum StorageType {
    FileSystem = "filesystem",
    PostgreSQL = "postgresql",
}

export const storageType = (await initPostgreSQL())
    ? StorageType.PostgreSQL
    : StorageType.FileSystem;

logger.info("storage", `Storage type [${storageType}]`);

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
