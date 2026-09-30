export type EntityName = "edge" | "tunnel";

export type Item = Record<string, any> & { id: string };

export type WhereOperator = "eq" | "neq" | "in" | "like";

export interface WhereCondition {
    column: string; // a column name or "metadata.<key>"
    value: any;
    operator?: WhereOperator; // default "eq"
}

export interface QueryContext {
    where?: WhereCondition[];
    limit?: number;
    offset?: number;
    orderBy?: { column: string; direction: "asc" | "desc" };
}

export interface StorageProvider {
    list(entity: EntityName, query?: QueryContext): Promise<{ items: Item[]; total: number }>;
    find(entity: EntityName, where: WhereCondition[]): Promise<Item[]>;
    get(entity: EntityName, id: string, query?: QueryContext): Promise<Item | null>;
    getByToken(entity: EntityName, token: string): Promise<Item | null>;
    add(entity: EntityName, item: Omit<Item, "id">): Promise<Item>;
    update(
        entity: EntityName,
        id: string,
        changes: Partial<Item>,
        query?: QueryContext
    ): Promise<Item | null>;
    remove(entity: EntityName, id: string, query?: QueryContext): Promise<Item | null>;
    /** Runs fn atomically: all changes are committed together or not at all. */
    transaction<T>(fn: (tx: StorageProvider) => Promise<T>): Promise<T>;
    /** Flushes pending writes and releases resources. */
    close(): Promise<void>;
}
