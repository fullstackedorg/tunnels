import { getTableName } from "drizzle-orm";
import {
    getTableConfig,
    PgColumn,
    PgTableWithColumns,
} from "drizzle-orm/pg-core";
import { add, find, Item, list, remove, update } from "../storage/index";
import http from "node:http";
import { respondJSON } from "../api/index";
import { readAll } from "../utils/readAll";
import { generateToken } from "../utils/token";
import crypto from "node:crypto";
import { logger } from "../utils/logger";
import * as kv from "../kv/index";

import { ColumnBaseConfig } from "drizzle-orm";
import { executeHook } from "../utils/hooks";

export type TableSchema = {
    name: string;
    schema: string | undefined;
    columns: Record<string, PgColumn<any>> & {
        id: PgColumn<ColumnBaseConfig<any, any> & { data: crypto.UUID }>;
    };
    dialect: "pg";
};

export async function invalidateItem<T extends TableSchema = TableSchema>(
    table: PgTableWithColumns<T>,
    token: string,
) {
    const tableName = getTableName(table);
    const key = `${tableName}:${token}`;
    await kv.del(key);
}

export async function getByToken<T extends TableSchema = TableSchema>(
    table: PgTableWithColumns<T>,
    token: string | undefined,
): Promise<Item | null> {
    if (!token) {
        return null;
    }

    const tableName = getTableName(table);
    const key = `${tableName}:${token}`;

    const cached = await kv.get<Item>(key);
    if (cached !== null && cached !== undefined) {
        return cached;
    }

    const found = await find(table, {
        column: "token",
        value: token,
    });

    const item = found.length === 0 ? null : (found[0] as Item);
    if (item !== null) {
        await kv.set(key, item);
    }
    return item;
}

export function entityCRUD<T extends TableSchema = TableSchema>(
    table: PgTableWithColumns<T>,
) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const tableName = getTableName(table);
        logger.info(
            "Entity",
            `Processing request for: ${req.method} [${tableName}]`,
        );

        switch (req.method) {
            case "GET":
                const items = await list(table);
                await executeHook(`get_${tableName}`, req, items);
                return respondJSON(res, items);
            case "POST":
                const item = await readAll(req, "json");

                if (
                    getTableConfig(table).columns.find(
                        ({ name }) => name === "token",
                    )
                ) {
                    item.token = generateToken();
                }

                const insertedItem = await add(table, item);

                await executeHook(`post_${tableName}`, req, insertedItem);

                return respondJSON(res, insertedItem);
            case "PUT":
                const id = req
                    .url!.split("/")
                    .filter(Boolean)
                    .at(1) as crypto.UUID;
                if (!id) {
                    res.writeHead(400);
                    res.end();
                    return true;
                }
                const itemToUpdate = await readAll(req, "json");
                const updatedItem = await update(table, id, itemToUpdate);
                await invalidateItem(table, updatedItem.token);

                await executeHook(`put_${tableName}`, req, updatedItem);

                return respondJSON(res, updatedItem);
            case "DELETE":
                const idToDelete = req
                    .url!.split("/")
                    .filter(Boolean)
                    .at(1) as crypto.UUID;
                if (!idToDelete) {
                    res.writeHead(400);
                    res.end();
                    return true;
                }
                const removedItem = await remove(table, idToDelete);
                if (removedItem) {
                    await invalidateItem(table, removedItem.token);
                }

                await executeHook(`delete_${tableName}`, req, removedItem);

                return respondJSON(res, { id: removedItem?.id });
        }

        return false;
    };
}
