import { PgTableWithColumns } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";
import { getDb, initPostgreSQL } from "./postgresql";
import { getFileSystemCollection } from "./filesystem";
import { logger } from "../utils/logger";

export enum StorageType {
    FileSystem = "filesystem",
    PostgreSQL = "postgresql",
}

export const storageType = (await initPostgreSQL())
    ? StorageType.PostgreSQL
    : StorageType.FileSystem;

logger.info("storage", `Storage type [${storageType}]`);

export type Item = Record<string, any> & { id: crypto.UUID | number };

type WhereValue = {
    column: string;
    value: any;
};

export async function list(table: PgTableWithColumns<any>) {
    if (storageType === StorageType.PostgreSQL) {
        return getDb().select().from(table);
    }

    const collection = await getFileSystemCollection(table);
    return collection.all();
}

export async function find(
    table: PgTableWithColumns<any>,
    where: WhereValue | WhereValue[],
) {
    const whereArr = Array.isArray(where) ? where : [where];

    if (storageType === StorageType.PostgreSQL) {
        return getDb()!
            .select()
            .from(table)
            .where(
                and(
                    ...whereArr.map(({ column, value }) =>
                        eq(table[column], value),
                    ),
                ),
            );
    }

    const collection = await getFileSystemCollection(table);
    return collection
        .all()
        .filter((row) =>
            whereArr.every(({ column, value }) => row[column] === value),
        );
}

// return ID of inserted item
export async function add(
    table: PgTableWithColumns<any>,
    item: Omit<Item, "id">,
) {
    if (storageType === StorageType.PostgreSQL) {
        return (await getDb().insert(table).values(item).returning()).at(0);
    }

    const collection = await getFileSystemCollection(table);
    return collection.add(item);
}

export async function get(table: PgTableWithColumns<any>, id: string | number) {
    if (storageType === StorageType.PostgreSQL) {
        return (await getDb().select().from(table).where(eq(table.id, id))).at(
            0,
        );
    }

    const collection = await getFileSystemCollection(table);
    return collection.all().find((row) => row.id === id);
}

export async function update(
    table: PgTableWithColumns<any>,
    id: crypto.UUID | number,
    item: Partial<Item>,
) {
    if (storageType === StorageType.PostgreSQL) {
        return (
            await getDb()
                .update(table)
                .set(item)
                .where(eq(table.id, id))
                .returning()
        ).at(0);
    }

    const collection = await getFileSystemCollection(table);
    return collection.update(id, item);
}

export async function remove(
    table: PgTableWithColumns<any>,
    id: crypto.UUID | number,
) {
    if (storageType === StorageType.PostgreSQL) {
        return (
            await getDb().delete(table).where(eq(table.id, id)).returning()
        ).at(0);
    }

    const collection = await getFileSystemCollection(table);
    return collection.remove(id);
}
