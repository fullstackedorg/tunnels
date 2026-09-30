import test from "node:test";
import assert from "node:assert/strict";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import { parseConfig } from "../src/utils/config.ts";
import { getAvailablePort, createTempDir, cleanupTempDir, jsonFetch } from "./helpers.ts";
import { kv } from "../src/kv/index.ts";

test("api: full CRUDL and token rolling for tunnels and edges", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const dir = createTempDir("api-test-");

    const config = parseConfig(["--port", String(port), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    try {
        hub = await startHub(config);
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. Create edge
        const createEdgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Gateway Edge", metadata: { cluster: "east" } },
        });
        assert.equal(createEdgeRes.status, 201);
        assert.ok(createEdgeRes.data.id);
        assert.ok(createEdgeRes.data.token.startsWith("edg_"));
        assert.equal(createEdgeRes.data.name, "Gateway Edge");
        const edgeId = createEdgeRes.data.id;

        // 2. Read edge (computed fields: connected and lastSeen)
        const readEdgeRes = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
        assert.equal(readEdgeRes.status, 200);
        assert.equal(readEdgeRes.data.connected, false);
        assert.equal(readEdgeRes.data.lastSeen, null);

        // 3. Create tunnel bound to edge
        const createTunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Postgres Relay",
                internalHost: "10.0.0.5",
                internalPort: 5432,
                edgeId,
                metadata: { tier: "db" },
            },
        });
        assert.equal(createTunRes.status, 201);
        assert.ok(createTunRes.data.id);
        assert.ok(createTunRes.data.token.startsWith("tun_"));
        const tunnelId = createTunRes.data.id;

        // 4. List tunnels with X-Total-Count
        const listTunRes = await jsonFetch(`${baseUrl}/tunnels?limit=10`);
        assert.equal(listTunRes.status, 200);
        assert.equal(listTunRes.headers.get("x-total-count"), "1");
        assert.equal(listTunRes.data.length, 1);
        assert.equal(listTunRes.data[0].id, tunnelId);

        // 5. Update tunnel (partial metadata merge)
        const updateTunRes = await jsonFetch(`${baseUrl}/tunnels/${tunnelId}`, {
            method: "PATCH",
            body: {
                name: "Postgres Primary",
                metadata: { replica: false },
            },
        });
        assert.equal(updateTunRes.status, 200);
        assert.equal(updateTunRes.data.name, "Postgres Primary");
        assert.deepEqual(updateTunRes.data.metadata, { tier: "db", replica: false });

        // 6. Roll tunnel token
        const oldTunToken = createTunRes.data.token;
        const rollTunRes = await jsonFetch(`${baseUrl}/tunnels/${tunnelId}/roll-token`, {
            method: "POST",
        });
        assert.equal(rollTunRes.status, 200);
        assert.ok(rollTunRes.data.token.startsWith("tun_"));
        assert.notEqual(rollTunRes.data.token, oldTunToken);

        // 7. Cascading edge deletion deletes bound tunnels
        const deleteEdgeRes = await jsonFetch(`${baseUrl}/edges/${edgeId}`, {
            method: "DELETE",
        });
        assert.equal(deleteEdgeRes.status, 204);

        const afterEdgeDel = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
        assert.equal(afterEdgeDel.status, 404);

        const afterTunDel = await jsonFetch(`${baseUrl}/tunnels/${tunnelId}`);
        assert.equal(afterTunDel.status, 404);
    } finally {
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("api: scoping hook restricts access and returns 404 outside scope", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const dir = createTempDir("api-scope-");

    const config = parseConfig(["--port", String(port), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    try {
        hub = await startHub(config);
        const baseUrl = `http://127.0.0.1:${port}`;

        // Create tunnel belonging to tenant-A
        const tunA = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Tenant A Tunnel",
                internalHost: "127.0.0.1",
                internalPort: 8080,
                metadata: { tenant: "tenant-A" },
            },
        });
        assert.equal(tunA.status, 201);

        // Register scope hook that scopes to tenant-B
        registerHook("scope_tunnel", (_req, query) => {
            query.where = [
                ...(query.where || []),
                { column: "metadata.tenant", operator: "eq", value: "tenant-B" },
            ];
        });

        // Reading tenant-A tunnel under tenant-B scope returns 404
        const readRes = await jsonFetch(`${baseUrl}/tunnels/${tunA.data.id}`);
        assert.equal(readRes.status, 404);

        // Listing tunnels under tenant-B scope returns empty array and count 0
        const listRes = await jsonFetch(`${baseUrl}/tunnels`);
        assert.equal(listRes.status, 200);
        assert.equal(listRes.data.length, 0);
        assert.equal(listRes.headers.get("x-total-count"), "0");
    } finally {
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("api: invalid UUID in path returns 400 with Invalid identifier error", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const dir = createTempDir("api-uuid-");

    const config = parseConfig(["--port", String(port), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    try {
        hub = await startHub(config);
        const baseUrl = `http://127.0.0.1:${port}`;

        const endpoints = [
            { method: "GET", path: "/tunnels/not-a-valid-uuid" },
            { method: "PUT", path: "/tunnels/123-abc" },
            { method: "DELETE", path: "/tunnels/invalid" },
            { method: "POST", path: "/tunnels/invalid/roll-token" },
            { method: "GET", path: "/edges/not-a-valid-uuid" },
            { method: "PUT", path: "/edges/123-abc" },
            { method: "DELETE", path: "/edges/invalid" },
            { method: "POST", path: "/edges/invalid/roll-token" },
        ];

        for (const ep of endpoints) {
            const res = await jsonFetch(`${baseUrl}${ep.path}`, { method: ep.method });
            assert.equal(
                res.status,
                400,
                `Expected 400 Bad Request for ${ep.method} ${ep.path}, got ${res.status}`
            );
            assert.deepEqual(res.data, { error: "Invalid identifier" });
        }
    } finally {
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("api: edge presence bootId validation and presence key eviction on delete", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const dir = createTempDir("api-presence-");

    const config = parseConfig(["--port", String(port), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    try {
        hub = await startHub(config);
        const baseUrl = `http://127.0.0.1:${port}`;

        // Create edge
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Presence Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;

        // Simulate presence key left by a previous Hub boot (e.g. bootId 99999)
        await kv.set(`edge:${edgeId}:worker`, "99999:1", 60);
        await kv.set(`edge:${edgeId}:last_seen`, 1700000000, 60);

        // GET /edges/:id should report connected: false because bootId doesn't match current Hub bootId
        const checkStale = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
        assert.equal(checkStale.status, 200);
        assert.equal(checkStale.data.connected, false);
        assert.equal(checkStale.data.lastSeen, 1700000000);

        // Set presence with current Hub bootId
        await kv.set(`edge:${edgeId}:worker`, `${hub.bootId}:1`, 60);
        const checkLive = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
        assert.equal(checkLive.status, 200);
        assert.equal(checkLive.data.connected, true);

        // Delete edge: must evict presence keys from KV
        const delRes = await jsonFetch(`${baseUrl}/edges/${edgeId}`, { method: "DELETE" });
        assert.equal(delRes.status, 204);

        const workerKey = await kv.get(`edge:${edgeId}:worker`);
        const lastSeenKey = await kv.get(`edge:${edgeId}:last_seen`);
        assert.equal(workerKey, null, "Presence worker key was not evicted on edge delete");
        assert.equal(lastSeenKey, null, "Presence last_seen key was not evicted on edge delete");
    } finally {
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("api: edge update, roll-token, 404s, and payload validation failures", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const dir = createTempDir("api-edge-ops-");

    const config = parseConfig(["--port", String(port), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    try {
        hub = await startHub(config);
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. Invalid JSON body
        const badJsonRes = await fetch(`${baseUrl}/edges`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{not-json",
        });
        assert.equal(badJsonRes.status, 400);

        // 2. Validation failure on edge create (missing name)
        const invalidEdgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: {},
        });
        assert.equal(invalidEdgeRes.status, 400);

        // 3. Create valid edge
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Original Edge", metadata: { region: "us-west" } },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;
        const origToken = edgeRes.data.token;

        // 4. Update edge (PATCH)
        const patchRes = await jsonFetch(`${baseUrl}/edges/${edgeId}`, {
            method: "PATCH",
            body: { name: "Renamed Edge", metadata: { env: "prod" } },
        });
        assert.equal(patchRes.status, 200);
        assert.equal(patchRes.data.name, "Renamed Edge");
        assert.deepEqual(patchRes.data.metadata, { region: "us-west", env: "prod" });

        // 5. Update edge with invalid payload (e.g. invalid name)
        const badPatchRes = await jsonFetch(`${baseUrl}/edges/${edgeId}`, {
            method: "PATCH",
            body: { name: "" },
        });
        assert.equal(badPatchRes.status, 400);

        // 6. Roll edge token
        const rollRes = await jsonFetch(`${baseUrl}/edges/${edgeId}/roll-token`, {
            method: "POST",
        });
        assert.equal(rollRes.status, 200);
        assert.notEqual(rollRes.data.token, origToken);
        assert.ok(rollRes.data.token.startsWith("edg_"));

        // 7. Not found for non-existent UUIDs
        const nonExistentId = crypto.randomUUID();
        const get404 = await jsonFetch(`${baseUrl}/edges/${nonExistentId}`);
        assert.equal(get404.status, 404);

        const patch404 = await jsonFetch(`${baseUrl}/edges/${nonExistentId}`, {
            method: "PATCH",
            body: { name: "ghost" },
        });
        assert.equal(patch404.status, 404);

        const del404 = await jsonFetch(`${baseUrl}/edges/${nonExistentId}`, {
            method: "DELETE",
        });
        assert.equal(del404.status, 404);

        const roll404 = await jsonFetch(`${baseUrl}/edges/${nonExistentId}/roll-token`, {
            method: "POST",
        });
        assert.equal(roll404.status, 404);

        // 8. Bad query params on tunnel list
        const badQueryRes = await jsonFetch(`${baseUrl}/tunnels?internalPort=invalid`);
        assert.equal(badQueryRes.status, 400);
    } finally {
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});
