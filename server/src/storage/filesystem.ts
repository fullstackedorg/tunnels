import path from "node:path";
import crypto from "node:crypto";
import type { Item, StorageProvider, WhereValue } from "./interface.ts";
import { getEnvOrArgCLI } from "../utils/args.ts";
import fs from "node:fs";
import { getTableConfig, type PgTableWithColumns } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import { logger } from "../utils/logger.ts";

type FileSystemCollectionStoredData = {
    lastId: number;
    data: Item[];
};

interface FileSystemCollection {
    add(item: Omit<Item, "id">): Item;
    all(): Item[];
    update(id: Item["id"], item: Partial<Item>): Item;
    remove(id: Item["id"]): Item | undefined;
}

const dataDirectory =
    getEnvOrArgCLI(["DATA_DIR", "data-dir", "d"], "string") || "data";

const storedDataCache = new Map<string, FileSystemCollectionStoredData>();
const dirtyCollectionsData = new Set<string>();

let lastFlush = 0,
    flushingLockPromise: Promise<void> | null;
function flushToDisk() {
    flushingLockPromise = new Promise<void>(async (resolve) => {
        let loggerMessage = `Flushing ${dirtyCollectionsData.size} collections to disk: ${[...dirtyCollectionsData].map((tableName) => `${tableName} [${storedDataCache.get(tableName)!.data.length} items]`).join(", ")}`;
        logger.info("Storage.FileSystem", loggerMessage);

        lastFlush = Date.now();

        const writePromises: Promise<void>[] = [];

        for (const dirtyTableName of dirtyCollectionsData) {
            const collection = storedDataCache.get(dirtyTableName)!;
            const collectionFilePath = path.resolve(
                dataDirectory,
                dirtyTableName + ".json",
            );
            writePromises.push(
                fs.promises.writeFile(
                    collectionFilePath,
                    JSON.stringify(collection, null, 2),
                ),
            );
            logger.info("Storage.FileSystem", `Writing ${collectionFilePath}`);
        }

        await Promise.all(writePromises);
        dirtyCollectionsData.clear();
        flushingLockPromise = null;
        resolve();
    });
}

let flushTimeout: NodeJS.Timeout | undefined;
function flushToDiskThrottled(wait = 5000) {
    const diffToLastFlush = Date.now() - lastFlush;
    if (diffToLastFlush < wait) {
        if (flushTimeout) {
            clearTimeout(flushTimeout);
        }
        flushTimeout = setTimeout(() => {
            flushTimeout = undefined;
            flushToDisk();
        }, wait - diffToLastFlush);
        flushTimeout.unref();
    } else {
        flushToDisk();
    }
}

export async function getFileSystemCollection(
    table: PgTableWithColumns<any>,
): Promise<FileSystemCollection> {
    await fs.promises.mkdir(dataDirectory, { recursive: true });
    const tableName = getTableName(table);
    let fsCollectionStoredData = storedDataCache.get(tableName);

    const markAsDirty = async () => {
        if (flushingLockPromise) await flushingLockPromise;
        dirtyCollectionsData.add(tableName);
        flushToDiskThrottled();
    };

    if (fsCollectionStoredData === undefined) {
        const collectionFilePath = path.resolve(
            dataDirectory,
            tableName + ".json",
        );

        fsCollectionStoredData = {
            lastId: 0,
            data: [],
        };

        try {
            await fs.promises.access(collectionFilePath);
            const raw = await fs.promises.readFile(collectionFilePath, "utf-8");
            fsCollectionStoredData = JSON.parse(
                raw,
            ) as FileSystemCollectionStoredData;
        } catch {}

        storedDataCache.set(tableName, fsCollectionStoredData);
    }

    const idType = getTableConfig(table).columns.find(
        ({ name }) => name === "id",
    )?.dataType;

    return {
        add: (item) => {
            let id: Item["id"];
            if (idType === "number") {
                id = fsCollectionStoredData.lastId + 1;
                fsCollectionStoredData.lastId = id;
            } else {
                id = crypto.randomUUID();
            }
            item.id = id;
            logger.info(
                "Storage.FileSystem",
                `Added ${tableName} with id ${id}`,
            );
            fsCollectionStoredData.data.push(item as Item);
            markAsDirty();
            return item as Item;
        },
        all: () => fsCollectionStoredData.data,
        update: (id, item) => {
            const index = fsCollectionStoredData.data.findIndex(
                (row) => row.id === id,
            );
            if (index === -1) {
                throw new Error(`Item with id ${id} not found`);
            }
            fsCollectionStoredData.data[index] = {
                ...fsCollectionStoredData.data[index],
                ...item,
            };
            markAsDirty();
            return fsCollectionStoredData.data[index];
        },
        remove: (id) => {
            const index = fsCollectionStoredData.data.findIndex(
                (row) => row.id === id,
            );
            if (index === -1) {
                throw new Error(`Item with id ${id} not found`);
            }
            const removed = fsCollectionStoredData.data.splice(index, 1);
            markAsDirty();
            return removed.at(0);
        },
    };
}

export class FileSystemStorageProvider implements StorageProvider {
    async list(table: PgTableWithColumns<any>) {
        const collection = await getFileSystemCollection(table);
        return collection.all();
    }

    async find(
        table: PgTableWithColumns<any>,
        where: WhereValue | WhereValue[],
    ) {
        const whereArr = Array.isArray(where) ? where : [where];
        const collection = await getFileSystemCollection(table);
        return collection
            .all()
            .filter((row) =>
                whereArr.every(
                    ({ column, value }) =>
                        (row[column] ?? null) === (value ?? null),
                ),
            );
    }

    async add(table: PgTableWithColumns<any>, item: Omit<Item, "id">) {
        const collection = await getFileSystemCollection(table);
        return collection.add(item);
    }

    async get(
        table: PgTableWithColumns<any>,
        id: crypto.UUID | number | string,
    ) {
        const collection = await getFileSystemCollection(table);
        return collection.all().find((row) => row.id === id);
    }

    async update(
        table: PgTableWithColumns<any>,
        id: crypto.UUID | number,
        item: Partial<Item>,
    ) {
        const collection = await getFileSystemCollection(table);
        return collection.update(id, item);
    }

    async remove(table: PgTableWithColumns<any>, id: crypto.UUID | number) {
        const collection = await getFileSystemCollection(table);
        return collection.remove(id);
    }
}
