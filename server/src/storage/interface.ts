import type { PgTableWithColumns } from "drizzle-orm/pg-core";
import crypto from "node:crypto";

export type Item = Record<string, any> & { id: crypto.UUID | number };

export type WhereValue = {
    column: string;
    value: any;
};

export interface StorageProvider {
    list(table: PgTableWithColumns<any>): Promise<Item[]>;
    find(
        table: PgTableWithColumns<any>,
        where: WhereValue | WhereValue[],
    ): Promise<Item[]>;
    add(table: PgTableWithColumns<any>, item: Omit<Item, "id">): Promise<Item>;
    get(
        table: PgTableWithColumns<any>,
        id: crypto.UUID | number | string,
    ): Promise<Item | undefined>;
    update(
        table: PgTableWithColumns<any>,
        id: crypto.UUID | number,
        item: Partial<Item>,
    ): Promise<Item>;
    remove(
        table: PgTableWithColumns<any>,
        id: crypto.UUID | number,
    ): Promise<Item | undefined>;
}
