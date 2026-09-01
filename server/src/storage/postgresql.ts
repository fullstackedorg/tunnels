import { getEnvOrArgCLI } from "../utils/args.ts";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTableWithColumns } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";
import type { Item, StorageProvider, WhereValue } from "./interface.ts";

let db: ReturnType<typeof drizzle> | null = null;
export async function initPostgreSQL() {
    const config = getEnvOrArgCLI(["POSTGRES_URL", "postgres-url"], "string");

    if (!config) {
        return false;
    }

    const client = new Pool({
        connectionString: config,
    });

    await client.connect();
    await client.query("SELECT 1");

    db = drizzle({ client });

    return true;
}

export function getDb() {
    if (!db) {
        throw new Error("PostgreSQL not initialized");
    }
    return db;
}

export class PostgreSQLStorageProvider implements StorageProvider {
    async list(table: PgTableWithColumns<any>) {
        return getDb().select().from(table) as unknown as Promise<Item[]>;
    }

    async find(
        table: PgTableWithColumns<any>,
        where: WhereValue | WhereValue[],
    ) {
        const whereArr = Array.isArray(where) ? where : [where];
        return getDb()!
            .select()
            .from(table)
            .where(
                and(
                    ...whereArr.map(({ column, value }) =>
                        eq(table[column], value),
                    ),
                ),
            ) as unknown as Promise<Item[]>;
    }

    async add(table: PgTableWithColumns<any>, item: Omit<Item, "id">) {
        return (await getDb().insert(table).values(item).returning()).at(
            0,
        ) as Item;
    }

    async get(
        table: PgTableWithColumns<any>,
        id: crypto.UUID | number | string,
    ) {
        return (await getDb().select().from(table).where(eq(table.id, id))).at(
            0,
        ) as Item;
    }

    async update(
        table: PgTableWithColumns<any>,
        id: crypto.UUID | number,
        item: Partial<Item>,
    ) {
        return (
            await getDb()
                .update(table)
                .set(item)
                .where(eq(table.id, id))
                .returning()
        ).at(0) as Item;
    }

    async remove(table: PgTableWithColumns<any>, id: crypto.UUID | number) {
        return (
            await getDb().delete(table).where(eq(table.id, id)).returning()
        ).at(0) as Item;
    }
}
