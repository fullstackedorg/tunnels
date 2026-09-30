import test from "node:test";
import assert from "node:assert/strict";
import { FilesystemStorageProvider } from "../src/storage/filesystem.ts";
import { createTempDir, cleanupTempDir } from "./helpers.ts";

test("storage: basic add, get, update, and remove", async () => {
    const dir = createTempDir("storage-crud-");
    const storage = new FilesystemStorageProvider(dir);

    try {
        const edge = await storage.add("edge", {
            token: "edg_123",
            name: "My Edge",
            version: "0.1.0",
            metadata: { env: "prod" },
        });

        assert.ok(edge.id);
        assert.equal(edge.name, "My Edge");

        const fetched = await storage.get("edge", edge.id);
        assert.deepEqual(fetched, edge);

        const updated = await storage.update("edge", edge.id, {
            name: "Updated Edge",
            metadata: { region: "us-east-1" },
        });

        assert.equal(updated?.name, "Updated Edge");
        assert.deepEqual(updated?.metadata, { env: "prod", region: "us-east-1" });

        const removed = await storage.remove("edge", edge.id);
        assert.equal(removed?.id, edge.id);

        const afterRemove = await storage.get("edge", edge.id);
        assert.equal(afterRemove, null);
    } finally {
        await storage.close();
        cleanupTempDir(dir);
    }
});

test("storage: query operators eq, neq, in, like, and metadata.<key>", async () => {
    const dir = createTempDir("storage-query-");
    const storage = new FilesystemStorageProvider(dir);

    try {
        await storage.add("tunnel", {
            token: "tun_1",
            name: "postgres-primary",
            internalHost: "127.0.0.1",
            internalPort: 5432,
            edgeId: null,
            metadata: { tenant: "org-1", tier: "gold" },
        });

        await storage.add("tunnel", {
            token: "tun_2",
            name: "redis-cache",
            internalHost: "127.0.0.1",
            internalPort: 6379,
            edgeId: null,
            metadata: { tenant: "org-1", tier: "silver" },
        });

        await storage.add("tunnel", {
            token: "tun_3",
            name: "internal-api",
            internalHost: "10.0.0.1",
            internalPort: 8080,
            edgeId: null,
            metadata: { tenant: "org-2", tier: "bronze" },
        });

        // eq operator
        const eqRes = await storage.list("tunnel", {
            where: [{ column: "internalPort", operator: "eq", value: 5432 }],
        });
        assert.equal(eqRes.total, 1);
        assert.equal(eqRes.items[0].name, "postgres-primary");

        // metadata.<key> eq
        const metaRes = await storage.list("tunnel", {
            where: [{ column: "metadata.tenant", operator: "eq", value: "org-1" }],
        });
        assert.equal(metaRes.total, 2);

        // like operator (case-insensitive substring)
        const likeRes = await storage.list("tunnel", {
            where: [{ column: "name", operator: "like", value: "POSTGRES" }],
        });
        assert.equal(likeRes.total, 1);
        assert.equal(likeRes.items[0].name, "postgres-primary");

        // in operator
        const inRes = await storage.list("tunnel", {
            where: [{ column: "internalPort", operator: "in", value: [5432, 6379] }],
        });
        assert.equal(inRes.total, 2);

        // neq operator on metadata
        const neqRes = await storage.list("tunnel", {
            where: [{ column: "metadata.tenant", operator: "neq", value: "org-1" }],
        });
        assert.equal(neqRes.total, 1);
        assert.equal(neqRes.items[0].name, "internal-api");

        // in operator on metadata
        const inMetaRes = await storage.list("tunnel", {
            where: [{ column: "metadata.tier", operator: "in", value: ["gold", "bronze"] }],
        });
        assert.equal(inMetaRes.total, 2);

        // sorting and pagination
        const sortRes = await storage.list("tunnel", {
            orderBy: { column: "internalPort", direction: "desc" },
            limit: 2,
            offset: 0,
        });
        assert.equal(sortRes.items[0].internalPort, 8080);
        assert.equal(sortRes.items[1].internalPort, 6379);
    } finally {
        await storage.close();
        cleanupTempDir(dir);
    }
});

test("storage: cascading edge deletion removes child tunnels", async () => {
    const dir = createTempDir("storage-cascade-");
    const storage = new FilesystemStorageProvider(dir);

    try {
        const edge = await storage.add("edge", {
            token: "edg_parent",
            name: "Parent Edge",
            version: "0.1.0",
            metadata: {},
        });

        const child1 = await storage.add("tunnel", {
            token: "tun_c1",
            name: "Child 1",
            internalHost: "localhost",
            internalPort: 8080,
            edgeId: edge.id,
            metadata: {},
        });

        const child2 = await storage.add("tunnel", {
            token: "tun_c2",
            name: "Child 2",
            internalHost: "localhost",
            internalPort: 9090,
            edgeId: edge.id,
            metadata: {},
        });

        // Delete parent edge
        await storage.remove("edge", edge.id);

        const edgeCheck = await storage.get("edge", edge.id);
        assert.equal(edgeCheck, null);

        const child1Check = await storage.get("tunnel", child1.id);
        const child2Check = await storage.get("tunnel", child2.id);
        assert.equal(child1Check, null);
        assert.equal(child2Check, null);
    } finally {
        await storage.close();
        cleanupTempDir(dir);
    }
});

test("storage: transaction rolls back changes on throw", async () => {
    const dir = createTempDir("storage-tx-");
    const storage = new FilesystemStorageProvider(dir);

    try {
        await assert.rejects(
            async () => {
                await storage.transaction(async (tx) => {
                    await tx.add("edge", {
                        token: "edg_rollback",
                        name: "Rollback Edge",
                        version: "0.1.0",
                        metadata: {},
                    });
                    throw new Error("Transaction aborted");
                });
            },
            {
                message: "Transaction aborted",
            }
        );

        const list = await storage.list("edge");
        assert.equal(list.total, 0);
    } finally {
        await storage.close();
        cleanupTempDir(dir);
    }
});
