import test from "node:test";
import assert from "node:assert/strict";
import { startHub } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import { registerRoute, clearCustomRoutes } from "../src/api/index.ts";
import { storage } from "../src/storage/index.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    jsonFetch,
    connectTestWs,
    createTestEchoServer,
} from "./helpers.ts";

test("api-extended: rest_access hook gating denial and error", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("rest-access-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. rest_access denies with 403
        registerHook("rest_access", (req) => {
            req.deny(403, "Custom Rest Access Denied");
        });
        const res1 = await jsonFetch(`${baseUrl}/edges`);
        assert.equal(res1.status, 403);
        assert.equal(res1.data.error, "Custom Rest Access Denied");

        // 2. rest_access throws -> 500
        clearHooks();
        registerHook("rest_access", () => {
            throw new Error("Boom");
        });
        const res2 = await jsonFetch(`${baseUrl}/edges`);
        assert.equal(res2.status, 500);
        assert.equal(res2.data.error, "Internal Server Error");
    } finally {
        clearHooks();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-extended: pre-mutation hook invalid field mutation returns 500", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("invalid-mutation-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;

        // Hook mutates tunnel payload to invalid port
        registerHook("create_tunnel", (_req, payload) => {
            payload.internalPort = 999999;
        });

        const res = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Valid Tunnel",
                internalHost: "127.0.0.1",
                internalPort: 8080,
            },
        });

        assert.equal(res.status, 500);
        assert.deepEqual(res.data, { error: "Internal Server Error" });
    } finally {
        clearHooks();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-extended: post-query hooks fail-closed with 500 on throw", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("post-query-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;

        registerHook("list_edge_done", () => {
            throw new Error("Post-query crashed");
        });

        const res = await jsonFetch(`${baseUrl}/edges`);
        assert.equal(res.status, 500);
        assert.equal(res.data.error, "Internal Server Error");
    } finally {
        clearHooks();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-extended: edgeId foreign key check returns 400 on create and update", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("fk-edge-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;

        // Create with fake edgeId
        const resCreate = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "FK Tunnel",
                internalHost: "127.0.0.1",
                internalPort: 8080,
                edgeId: "00000000-0000-0000-0000-000000000000",
            },
        });
        assert.equal(resCreate.status, 400);
        assert.equal(resCreate.data.error, "Invalid edge identifier");

        // Create a direct tunnel first
        const direct = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Direct Tunnel",
                internalHost: "127.0.0.1",
                internalPort: 8080,
            },
        });
        assert.equal(direct.status, 201);
        const tunnelId = direct.data.id;

        // Update to non-existent edgeId
        const resUpdate = await jsonFetch(`${baseUrl}/tunnels/${tunnelId}`, {
            method: "PATCH",
            body: {
                edgeId: "00000000-0000-0000-0000-000000000000",
            },
        });
        assert.equal(resUpdate.status, 400);
        assert.equal(resUpdate.data.error, "Invalid edge identifier");
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-extended: metadata null key deletion and full reset", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("meta-reset-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: {
                name: "Meta Edge",
                metadata: { keyA: "1", keyB: "2", keyC: "3" },
            },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;
        assert.equal(edgeRes.data.metadata.keyA, "1");

        // Delete keyA by passing null
        const patch1 = await jsonFetch(`${baseUrl}/edges/${edgeId}`, {
            method: "PATCH",
            body: {
                metadata: { keyA: null },
            },
        });
        assert.equal(patch1.status, 200);
        assert.equal(patch1.data.metadata.keyA, undefined);
        assert.equal(patch1.data.metadata.keyB, "2");

        // Reset metadata entirely with null
        const patch2 = await jsonFetch(`${baseUrl}/edges/${edgeId}`, {
            method: "PATCH",
            body: {
                metadata: null,
            },
        });
        assert.equal(patch2.status, 200);
        assert.deepEqual(patch2.data.metadata, {});
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-extended: tunnel update modifying internalPort severs sessions with 1000 tunnel_updated", async () => {
    clearHooks();
    const echo = await createTestEchoServer();
    const port = await getAvailablePort();
    const tempDir = createTempDir("tunnel-update-sever-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const createRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Update Sever Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        assert.equal(createRes.status, 201);
        const tunnel = createRes.data;

        const ws = await connectTestWs(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: tunnel.token },
        });

        const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });

        // Updating name does NOT sever session
        const nameRes = await jsonFetch(`${baseUrl}/tunnels/${tunnel.id}`, {
            method: "PATCH",
            body: { name: "Renamed Tunnel" },
        });
        assert.equal(nameRes.status, 200);

        // Updating internalPort DOES sever session
        const portRes = await jsonFetch(`${baseUrl}/tunnels/${tunnel.id}`, {
            method: "PATCH",
            body: { internalPort: echo.port + 1 },
        });
        assert.equal(portRes.status, 200);

        const closeResult = await closePromise;
        assert.equal(closeResult.code, 1000);
        assert.equal(closeResult.reason, "tunnel_updated");
    } finally {
        await echo.close();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-extended: cascading edge delete aborts and rolls back when child delete_tunnel hook denies", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("cascade-rollback-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Parent Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;

        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Child Tunnel",
                edgeId,
                internalHost: "127.0.0.1",
                internalPort: 8080,
            },
        });
        assert.equal(tunRes.status, 201);
        const tunnelId = tunRes.data.id;

        // Deny child tunnel deletion
        registerHook("delete_tunnel", (req, _tunnel) => {
            req.deny(403, "Child tunnel deletion prohibited");
        });

        const delRes = await jsonFetch(`${baseUrl}/edges/${edgeId}`, {
            method: "DELETE",
        });
        assert.equal(delRes.status, 403);

        // Verify edge and tunnel still exist in storage (transaction rollback)
        const edgeStillExists = await storage.get("edge", edgeId);
        assert.ok(edgeStillExists, "Edge should still exist");

        const tunStillExists = await storage.get("tunnel", tunnelId);
        assert.ok(tunStillExists, "Child tunnel should still exist");
    } finally {
        clearHooks();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-extended: custom prepended route overrides built-in route", async () => {
    clearHooks();
    clearCustomRoutes();
    const port = await getAvailablePort();
    const tempDir = createTempDir("prepend-route-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    const unreg = registerRoute(
        "/edges",
        (_req, res) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ customOverride: true }));
            return true;
        },
        { prepend: true }
    );

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const res = await jsonFetch(`${baseUrl}/edges`);
        assert.equal(res.status, 200);
        assert.equal(res.data.customOverride, true);
    } finally {
        unreg();
        clearCustomRoutes();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});
