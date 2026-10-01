import test from "node:test";
import assert from "node:assert/strict";
import { PostgreSQLStorageProvider } from "../src/storage/postgresql.ts";
import { createStorageProvider } from "../src/storage/index.ts";
import { edgeTable, tunnelTable } from "../src/entities/schema.ts";
import type { WhereCondition } from "../src/storage/interface.ts";

function createMockPg() {
    const queries: string[] = [];
    let schemaRows: any[] = [{ table_name: "edge" }, { table_name: "tunnel" }];
    let ended = false;

    const pool: any = {
        query: async (text: string) => {
            queries.push(text);
            if (text.includes("information_schema.tables")) {
                return { rows: schemaRows };
            }
            return { rows: [{ "?column?": 1 }] };
        },
        end: async () => {
            ended = true;
        },
    };

    let storedEdges: any[] = [];
    let storedTunnels: any[] = [];
    let nextInsertError: any = null;
    let nextUpdateError: any = null;

    const createSelectChain = (entity: "edge" | "tunnel", isCount = false) => {
        let rows = entity === "edge" ? [...storedEdges] : [...storedTunnels];
        const chain: any = {
            where: (cond: any) => {
                const visited = new Set();
                const vals: any[] = [];
                const walk = (n: any) => {
                    if (!n || typeof n !== "object" || visited.has(n)) return;
                    visited.add(n);
                    if ("value" in n && "encoder" in n) {
                        vals.push(n.value);
                        return;
                    }
                    if (Array.isArray(n)) {
                        for (const x of n) walk(x);
                    } else if (n.queryChunks) {
                        for (const x of n.queryChunks) walk(x);
                    }
                };
                walk(cond);
                if (vals.includes("nonexistent")) {
                    rows = [];
                }
                return chain;
            },
            orderBy: (_order: any) => chain,
            limit: (n: number) => {
                rows = rows.slice(0, n);
                return chain;
            },
            offset: (n: number) => {
                rows = rows.slice(n);
                return chain;
            },
            then: (resolve: any, reject: any) => {
                if (isCount) {
                    return Promise.resolve([{ count: rows.length }]).then(resolve, reject);
                }
                return Promise.resolve(rows).then(resolve, reject);
            },
        };
        return chain;
    };

    const db: any = {
        select: (fields?: any) => ({
            from: (table: any) => {
                const entity = table === edgeTable ? "edge" : "tunnel";
                return createSelectChain(entity, Boolean(fields?.count));
            },
        }),
        insert: (table: any) => ({
            values: (val: any) => ({
                returning: async () => {
                    if (nextInsertError) {
                        const err = nextInsertError;
                        nextInsertError = null;
                        throw err;
                    }
                    const entity = table === edgeTable ? "edge" : "tunnel";
                    const record = { id: val.id || "gen-uuid", ...val };
                    if (entity === "edge") storedEdges.push(record);
                    else storedTunnels.push(record);
                    return [record];
                },
            }),
        }),
        update: (table: any) => ({
            set: (vals: any) => ({
                where: (_whereCond: any) => ({
                    returning: async () => {
                        if (nextUpdateError) {
                            const err = nextUpdateError;
                            nextUpdateError = null;
                            throw err;
                        }
                        const entity = table === edgeTable ? "edge" : "tunnel";
                        const list = entity === "edge" ? storedEdges : storedTunnels;
                        const idx = list.findIndex((r) => r.id === (vals.id || list[0]?.id));
                        if (idx >= 0) {
                            list[idx] = { ...list[idx], ...vals };
                            return [list[idx]];
                        }
                        return [];
                    },
                }),
            }),
        }),
        delete: (table: any) => ({
            where: (_whereCond: any) => ({
                returning: async () => {
                    const entity = table === edgeTable ? "edge" : "tunnel";
                    const list = entity === "edge" ? storedEdges : storedTunnels;
                    const removed = list.shift();
                    return removed ? [removed] : [];
                },
            }),
        }),
        transaction: async (fn: any) => {
            return await fn(db);
        },
    };

    return {
        pool,
        db,
        queries,
        get ended() {
            return ended;
        },
        setSchemaRows: (rows: any[]) => {
            schemaRows = rows;
        },
        setInsertError: (err: any) => {
            nextInsertError = err;
        },
        setUpdateError: (err: any) => {
            nextUpdateError = err;
        },
        storedEdges,
        storedTunnels,
    };
}

test("postgresql: init succeeds when schema tables exist, throws when missing", async () => {
    const mock = createMockPg();
    const provider = new PostgreSQLStorageProvider(mock.pool, mock.db);

    await provider.init();
    assert.equal(mock.queries.length, 2);
    assert.equal(mock.queries[0], "SELECT 1");

    mock.setSchemaRows([{ table_name: "edge" }]);
    await assert.rejects(
        async () => await provider.init(),
        /Database schema not initialized: 'edge' and\/or 'tunnel' tables missing/
    );
});

test("postgresql: add, get, getByToken, and conflict handling", async () => {
    const mock = createMockPg();
    const provider = new PostgreSQLStorageProvider(mock.pool, mock.db);

    const edge = await provider.add("edge", {
        token: "edg_test_1",
        name: "test-edge",
        version: "1.0.0",
        metadata: { env: "prod" },
    });
    assert.ok(edge.id);
    assert.equal(edge.name, "test-edge");

    const fetched = await provider.get("edge", edge.id);
    assert.ok(fetched);
    assert.equal(fetched.token, "edg_test_1");

    const byToken = await provider.getByToken("edge", "edg_test_1");
    assert.ok(byToken);
    assert.equal(byToken.id, edge.id);

    const notFoundToken = await provider.getByToken("edge", "nonexistent");
    assert.equal(notFoundToken, null);

    mock.setInsertError({ code: "23505" });
    await assert.rejects(
        async () =>
            await provider.add("edge", {
                token: "edg_test_1",
                name: "dup",
            }),
        /Conflict: Token already exists for edge/
    );

    mock.setInsertError(new Error("Database disconnected"));
    await assert.rejects(
        async () =>
            await provider.add("edge", {
                token: "edg_test_2",
                name: "err",
            }),
        /Database disconnected/
    );
});

test("postgresql: update with metadata merge, metadata reset, and conflict handling", async () => {
    const mock = createMockPg();
    const provider = new PostgreSQLStorageProvider(mock.pool, mock.db);

    const edge = await provider.add("edge", {
        token: "edg_meta_1",
        name: "meta-edge",
        metadata: { env: "staging", deleteMe: "val", keepMe: "stay" },
    });

    // Update with key removal (null)
    const updated = await provider.update("edge", edge.id, {
        metadata: { deleteMe: null, newKey: "added" },
    });
    assert.ok(updated);
    assert.equal(updated.metadata.deleteMe, undefined);
    assert.equal(updated.metadata.keepMe, "stay");
    assert.equal(updated.metadata.newKey, "added");

    // Reset metadata to empty with null
    const reset = await provider.update("edge", edge.id, {
        metadata: null,
    });
    assert.ok(reset);
    assert.deepEqual(reset.metadata, {});

    // Non-existent record returns null
    mock.storedEdges.length = 0;
    const nonExistent = await provider.update("edge", "missing-id", { name: "nope" });
    assert.equal(nonExistent, null);

    // Re-insert edge to test 23505 Conflict on update
    mock.storedEdges.push(edge);
    mock.setUpdateError({ code: "23505" });
    await assert.rejects(
        async () => await provider.update("edge", edge.id, { name: "collide" }),
        /Conflict: Token already exists for edge/
    );

    mock.setUpdateError(new Error("Fatal PG error"));
    await assert.rejects(
        async () => await provider.update("edge", edge.id, { name: "fatal" }),
        /Fatal PG error/
    );
});

test("postgresql: remove existing and non-existent entities", async () => {
    const mock = createMockPg();
    const provider = new PostgreSQLStorageProvider(mock.pool, mock.db);

    const edge = await provider.add("edge", {
        token: "edg_del_1",
        name: "edge-to-remove",
    });

    const removed = await provider.remove("edge", edge.id);
    assert.ok(removed);
    assert.equal(removed.id, edge.id);

    // Removing when not found returns null
    const removedAgain = await provider.remove("edge", edge.id);
    assert.equal(removedAgain, null);
});

test("postgresql: list and find with conditions, pagination, and sorting", async () => {
    const mock = createMockPg();
    const provider = new PostgreSQLStorageProvider(mock.pool, mock.db);

    await provider.add("tunnel", {
        token: "tun_1",
        name: "db-tunnel",
        internalHost: "127.0.0.1",
        internalPort: 5432,
        metadata: { cluster: "us-east", env: "prod" },
    });

    await provider.add("tunnel", {
        token: "tun_2",
        name: "redis-tunnel",
        internalHost: "127.0.0.1",
        internalPort: 6379,
        metadata: { cluster: "us-east", env: "dev" },
    });

    // Test list with count, ordering (desc, asc, unknown column), and pagination limits
    const conditions: WhereCondition[] = [
        { column: "internalPort", operator: "eq", value: 5432 },
        { column: "name", operator: "neq", value: "wrong" },
        { column: "internalPort", operator: "in", value: [5432, 6379] },
        { column: "name", operator: "like", value: "tunnel" },
        { column: "nonExistentCol", operator: "eq", value: "skip" },
        { column: "metadata.cluster", operator: "eq", value: "us-east" },
        { column: "metadata.env", operator: "neq", value: "dev" },
        { column: "metadata.cluster", operator: "in", value: ["us-east", "us-west"] },
        { column: "metadata.cluster", operator: "like", value: "east" },
        { column: "metadata.cluster", operator: "invalid_op" as any, value: "none" },
        { column: "name", operator: "invalid_op" as any, value: "none" },
    ];

    const listRes = await provider.list("tunnel", {
        where: conditions,
        orderBy: { column: "name", direction: "desc" },
        limit: 2000, // tests limit clamp
        offset: -5, // tests offset clamp
    });
    assert.equal(listRes.total, 2);
    assert.equal(listRes.items.length, 2);

    // Test asc ordering and unknown column
    await provider.list("tunnel", {
        orderBy: { column: "name", direction: "asc" },
    });
    await provider.list("tunnel", {
        orderBy: { column: "invalid_column", direction: "asc" },
    });

    // Test find with conditions and without conditions
    const foundWithWhere = await provider.find("tunnel", conditions);
    assert.equal(foundWithWhere.length, 2);

    const foundAll = await provider.find("tunnel", []);
    assert.equal(foundAll.length, 2);

    // Test get with additional where filter
    const getRes = await provider.get("tunnel", mock.storedTunnels[0].id, {
        where: [{ column: "internalPort", operator: "eq", value: 5432 }],
    });
    assert.ok(getRes);
});

test("postgresql: transaction, close, and string constructor instantiation", async () => {
    const mock = createMockPg();
    const provider = new PostgreSQLStorageProvider(mock.pool, mock.db);

    const txResult = await provider.transaction(async (tx) => {
        const edge = await tx.add("edge", {
            token: "edg_tx_1",
            name: "tx-edge",
        });
        return edge.name;
    });
    assert.equal(txResult, "tx-edge");

    await provider.close();
    assert.equal(mock.ended, true);

    // Test string connection string constructor and close
    const strProvider = new PostgreSQLStorageProvider("postgres://user:pass@localhost:5432/testdb");
    await strProvider.close();

    // Test createStorageProvider with postgresUrl branch
    const origInit = PostgreSQLStorageProvider.prototype.init;
    PostgreSQLStorageProvider.prototype.init = async function () {};
    try {
        const sp = await createStorageProvider({
            postgresUrl: "postgres://user:pass@localhost:5432/testdb",
        } as any);
        assert.ok(sp instanceof PostgreSQLStorageProvider);
        await sp.close();
    } finally {
        PostgreSQLStorageProvider.prototype.init = origInit;
    }
});
