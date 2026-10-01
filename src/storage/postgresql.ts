import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, ne, inArray, ilike, and, asc, desc, sql } from "drizzle-orm";
import type {
    EntityName,
    Item,
    QueryContext,
    StorageProvider,
    WhereCondition,
} from "./interface.ts";
import { edgeTable, tunnelTable } from "../entities/schema.ts";

export class PostgreSQLStorageProvider implements StorageProvider {
    private pool: pg.Pool;
    private db: NodePgDatabase;

    constructor(connectionStringOrPool: string | pg.Pool, dbInstance?: NodePgDatabase) {
        if (typeof connectionStringOrPool === "string") {
            this.pool = new pg.Pool({ connectionString: connectionStringOrPool });
            this.db = drizzle(this.pool);
        } else {
            this.pool = connectionStringOrPool;
            this.db = dbInstance || drizzle(this.pool);
        }
    }

    async init(): Promise<void> {
        await this.pool.query("SELECT 1");
        const res = await this.pool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('edge', 'tunnel')"
        );
        if (res.rows.length < 2) {
            throw new Error(
                "Database schema not initialized: 'edge' and/or 'tunnel' tables missing. Run: npx drizzle-kit push --config drizzle.config.ts"
            );
        }
    }

    private getTable(entity: EntityName) {
        return entity === "edge" ? edgeTable : tunnelTable;
    }

    private buildCondition(table: any, cond: WhereCondition) {
        const op = cond.operator || "eq";
        if (cond.column.startsWith("metadata.")) {
            const key = cond.column.slice(9);
            const jsonField = sql`${table.metadata}->>${key}`;
            if (op === "eq") return sql`${jsonField} = ${String(cond.value)}`;
            if (op === "neq")
                return sql`${jsonField} IS NOT NULL AND ${jsonField} != ${String(cond.value)}`;
            if (op === "in") return sql`${jsonField} IN ${cond.value}`;
            if (op === "like") return sql`${jsonField} ILIKE ${`%${cond.value}%`}`;
            return undefined;
        }

        const col = table[cond.column];
        if (!col) return undefined;

        if (op === "eq") return eq(col, cond.value);
        if (op === "neq") return ne(col, cond.value);
        if (op === "in") return inArray(col, cond.value);
        if (op === "like") return ilike(col, `%${cond.value}%`);
        return undefined;
    }

    private buildWhereClause(table: any, where?: WhereCondition[]) {
        if (!where || where.length === 0) return undefined;
        const exprs = where
            .map((c) => this.buildCondition(table, c))
            .filter((e): e is NonNullable<typeof e> => Boolean(e));
        return exprs.length ? and(...exprs) : undefined;
    }

    async list(
        entity: EntityName,
        query?: QueryContext
    ): Promise<{ items: Item[]; total: number }> {
        const table = this.getTable(entity);
        const whereClause = this.buildWhereClause(table, query?.where);

        const countQuery = this.db.select({ count: sql<number>`count(*)` }).from(table);
        const countRes = whereClause ? await countQuery.where(whereClause) : await countQuery;
        const total = Number(countRes[0]?.count ?? 0);

        let selectQuery = this.db.select().from(table) as any;
        if (whereClause) {
            selectQuery = selectQuery.where(whereClause);
        }

        const orderBy = query?.orderBy ?? { column: "id", direction: "asc" };
        const col = (table as any)[orderBy.column] ?? (table as any).id;
        selectQuery = selectQuery.orderBy(orderBy.direction === "desc" ? desc(col) : asc(col));

        const offset = Math.max(0, query?.offset ?? 0);
        const limit = Math.min(1000, Math.max(0, query?.limit ?? 100));
        const items = await selectQuery.limit(limit).offset(offset);

        return { items: items as Item[], total };
    }

    async find(entity: EntityName, where: WhereCondition[]): Promise<Item[]> {
        const table = this.getTable(entity);
        const whereClause = this.buildWhereClause(table, where);
        let q = this.db.select().from(table) as any;
        if (whereClause) {
            q = q.where(whereClause);
        }
        const items = await q;
        return items as Item[];
    }

    async get(entity: EntityName, id: string, query?: QueryContext): Promise<Item | null> {
        const table = this.getTable(entity);
        const conds: WhereCondition[] = [{ column: "id", operator: "eq", value: id }];
        if (query?.where) conds.push(...query.where);
        const whereClause = this.buildWhereClause(table, conds);

        const rows = await this.db.select().from(table).where(whereClause!).limit(1);
        return (rows[0] as Item) || null;
    }

    async getByToken(entity: EntityName, token: string): Promise<Item | null> {
        const table = this.getTable(entity);
        const rows = await this.db
            .select()
            .from(table)
            .where(eq((table as any).token, token))
            .limit(1);
        return (rows[0] as Item) || null;
    }

    async add(entity: EntityName, item: Omit<Item, "id">): Promise<Item> {
        const table = this.getTable(entity);
        try {
            const rows = await this.db
                .insert(table)
                .values(item as any)
                .returning();
            return rows[0] as Item;
        } catch (err: any) {
            if (err?.code === "23505") {
                throw new Error(`Conflict: Token already exists for ${entity}`);
            }
            throw err;
        }
    }

    async update(
        entity: EntityName,
        id: string,
        changes: Partial<Item>,
        query?: QueryContext
    ): Promise<Item | null> {
        const current = await this.get(entity, id, query);
        if (!current) return null;

        const table = this.getTable(entity);
        const updatedValues: any = { ...changes };

        if ("metadata" in changes) {
            const currentMeta = current.metadata || {};
            const newMeta = changes.metadata;
            if (newMeta === null) {
                updatedValues.metadata = {};
            } else if (typeof newMeta === "object") {
                const merged = { ...currentMeta, ...newMeta };
                for (const [k, v] of Object.entries(newMeta)) {
                    if (v === null) delete merged[k];
                }
                updatedValues.metadata = merged;
            }
        }

        try {
            const rows = await this.db
                .update(table)
                .set(updatedValues)
                .where(eq((table as any).id, id))
                .returning();
            return (rows[0] as Item) || null;
        } catch (err: any) {
            if (err?.code === "23505") {
                throw new Error(`Conflict: Token already exists for ${entity}`);
            }
            throw err;
        }
    }

    async remove(entity: EntityName, id: string, query?: QueryContext): Promise<Item | null> {
        const current = await this.get(entity, id, query);
        if (!current) return null;

        const table = this.getTable(entity);
        const rows = await this.db
            .delete(table)
            .where(eq((table as any).id, id))
            .returning();
        return (rows[0] as Item) || null;
    }

    async transaction<T>(fn: (tx: StorageProvider) => Promise<T>): Promise<T> {
        return await (this.db as any).transaction(async (tx: NodePgDatabase) => {
            const txProvider = new PostgreSQLStorageProvider(this.pool, tx);
            return await fn(txProvider);
        });
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}
