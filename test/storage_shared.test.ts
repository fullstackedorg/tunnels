import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FilesystemStorageProvider } from "../src/storage/filesystem.ts";
import { startHub } from "../src/hub/index.ts";
import { setStorage, storage } from "../src/storage/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { clearHooks } from "../src/utils/hooks.ts";
import { getAvailablePort, createTempDir, cleanupTempDir, jsonFetch } from "./helpers.ts";

test("storage_shared: shared mode synchronizes across two provider instances", async () => {
    const dir = createTempDir("storage-shared-");
    const p1 = new FilesystemStorageProvider(dir, true);
    const p2 = new FilesystemStorageProvider(dir, true);

    try {
        // Add item via p1
        const item1 = await p1.add("edge", {
            name: "Edge Shared 1",
            token: "edg_shared1",
            metadata: {},
        } as any);

        // p2 sees item1
        const foundOnP2 = await p2.get("edge", item1.id);
        assert.ok(foundOnP2);
        assert.equal(foundOnP2.name, "Edge Shared 1");

        // Add item via p2
        const item2 = await p2.add("edge", {
            name: "Edge Shared 2",
            token: "edg_shared2",
            metadata: {},
        } as any);

        // p1 sees item2
        const foundOnP1 = await p1.get("edge", item2.id);
        assert.ok(foundOnP1);
        assert.equal(foundOnP1.name, "Edge Shared 2");

        // Transaction on p1
        await p1.transaction(async (tx) => {
            await tx.update("edge", item1.id, { name: "Edge Shared 1 Updated" });
        });

        // p2 sees transaction update
        const updatedOnP2 = await p2.get("edge", item1.id);
        assert.equal(updatedOnP2?.name, "Edge Shared 1 Updated");
    } finally {
        await p1.close();
        await p2.close();
        cleanupTempDir(dir);
    }
});

test("storage_shared: stale lock breaking when lock file is older than 5s", async () => {
    const dir = createTempDir("stale-lock-");
    const lockPath = path.join(dir, "store.lock");

    // Create an artificial stale lock file with mtime 10s in the past
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath, "pid:99999", "utf-8");
    const oldTime = (Date.now() - 10000) / 1000;
    fs.utimesSync(lockPath, oldTime, oldTime);

    const provider = new FilesystemStorageProvider(dir, true);

    try {
        // Should break the stale lock and successfully add the item
        const item = await provider.add("edge", {
            name: "Broken Lock Edge",
            token: "edg_broken_lock",
            metadata: {},
        } as any);

        assert.ok(item.id);
        assert.equal(item.name, "Broken Lock Edge");
    } finally {
        await provider.close();
        cleanupTempDir(dir);
    }
});

test("storage_shared: reloadIfChanged detects direct file modification on disk", async () => {
    const dir = createTempDir("reload-disk-");
    const storePath = path.join(dir, "store.json");
    const provider = new FilesystemStorageProvider(dir, true);

    try {
        const item = await provider.add("edge", {
            name: "Before Edit",
            token: "edg_before_edit",
            metadata: {},
        } as any);

        // Modify store.json directly on disk behind provider's back
        const raw = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        raw.edge[0].name = "After External Disk Edit";
        // Ensure mtime changes
        fs.writeFileSync(storePath, JSON.stringify(raw, null, 2), "utf-8");
        const newTime = (Date.now() + 2000) / 1000;
        fs.utimesSync(storePath, newTime, newTime);

        // Reading via provider should reload and return updated name
        const reloaded = await provider.get("edge", item.id);
        assert.equal(reloaded?.name, "After External Disk Edit");
    } finally {
        await provider.close();
        cleanupTempDir(dir);
    }
});

test("storage_shared: token collision throws Conflict in storage and returns 409 Conflict in API", async () => {
    clearHooks();
    const dir = createTempDir("token-conflict-");
    const provider = new FilesystemStorageProvider(dir, true);

    try {
        await provider.add("edge", {
            name: "Edge 1",
            token: "edg_collision",
            metadata: {},
        } as any);

        // Direct storage collision throws
        await assert.rejects(
            async () => {
                await provider.add("edge", {
                    name: "Edge 2",
                    token: "edg_collision",
                    metadata: {},
                } as any);
            },
            (err: any) => {
                return err.message.includes("Conflict");
            }
        );
    } finally {
        await provider.close();
    }

    // API 409 conflict handling
    const port = await getAvailablePort();
    const config = parseConfig(["--port", String(port), "--data-dir", dir]);
    const hub = await startHub(config);

    const mockStorage = {
        transaction: async () => {
            throw new Error("Conflict: Token already exists for tunnel");
        },
    } as any;
    setStorage(mockStorage);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const res = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Conflict Tunnel",
                internalHost: "127.0.0.1",
                internalPort: 8080,
            },
        });
        assert.equal(res.status, 409);
        assert.ok(res.data.error.includes("Conflict"));
    } finally {
        setStorage(null);
        await hub.close();
        cleanupTempDir(dir);
    }
});
