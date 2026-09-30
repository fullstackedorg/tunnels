import test from "node:test";
import assert from "node:assert/strict";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { severSessions, registerSession, severLocalSessions } from "../src/tunnels/registry.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    createTestEchoServer,
    connectTestWs,
    jsonFetch,
} from "./helpers.ts";

test("revocation: rolling tunnel token severs active session with 1000 token_rolled", async () => {
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("revoc-tun-roll-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Create direct tunnel
        const createRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Direct Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        assert.equal(createRes.status, 201);
        const tunnelId = createRes.data.id;
        const tunnelToken = createRes.data.token;

        // Connect client
        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            ws.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });

        // Roll token via API
        const rollRes = await jsonFetch(`${baseUrl}/tunnels/${tunnelId}/roll-token`, {
            method: "POST",
        });
        assert.equal(rollRes.status, 200);

        // Active session should be immediately severed
        const closeEvent = await closePromise;
        assert.equal(closeEvent.code, 1000);
        assert.equal(closeEvent.reason, "token_rolled");

        // Old token should be rejected
        await assert.rejects(
            connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
                headers: { Authorization: tunnelToken },
            })
        );
    } finally {
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
    }
});

test("revocation: deleting tunnel severs active session with 1000 tunnel_deleted", async () => {
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("revoc-tun-del-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Create direct tunnel
        const createRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Direct Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        const tunnelId = createRes.data.id;
        const tunnelToken = createRes.data.token;

        // Connect client
        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            ws.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });

        // Delete tunnel via API
        const delRes = await jsonFetch(`${baseUrl}/tunnels/${tunnelId}`, {
            method: "DELETE",
        });
        assert.equal(delRes.status, 204);

        // Active session should be immediately severed
        const closeEvent = await closePromise;
        assert.equal(closeEvent.code, 1000);
        assert.equal(closeEvent.reason, "tunnel_deleted");
    } finally {
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
    }
});

test("revocation: deleting edge closes lifeline and severs active sessions", async () => {
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("revoc-edge-del-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Create edge
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Edge To Delete" },
        });
        const edgeId = edgeRes.data.id;
        const edgeToken = edgeRes.data.token;

        // Connect raw lifeline WS so we can observe close frame
        const lifelineWs = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: edgeToken },
        });

        const lifelineClosePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            lifelineWs.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });

        // Create child tunnel
        const tunnelRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Child Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
                edgeId,
            },
        });
        const tunnelId = tunnelRes.data.id;

        // Delete edge via API
        const delRes = await jsonFetch(`${baseUrl}/edges/${edgeId}`, {
            method: "DELETE",
        });
        assert.equal(delRes.status, 204);

        // Lifeline should be closed with edge_deleted
        const lifelineClose = await lifelineClosePromise;
        assert.equal(lifelineClose.code, 1000);
        assert.equal(lifelineClose.reason, "edge_deleted");

        // Child tunnel should also be deleted from storage
        const checkTun = await jsonFetch(`${baseUrl}/tunnels/${tunnelId}`);
        assert.equal(checkTun.status, 404);
    } finally {
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
    }
});

test("revocation: programmatic severSessions API severs matching sessions", async () => {
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("revoc-prog-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        const createRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Direct Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        const tunnelId = createRes.data.id;
        const tunnelToken = createRes.data.token;

        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            ws.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });

        // Wait a tick for session to be registered on Hub
        await new Promise((r) => setTimeout(r, 50));

        // Programmatic severSessions call
        const severed = await severSessions({ tunnelId }, "tunnel_updated");
        assert.ok(severed >= 1);

        const closeEvent = await closePromise;
        assert.equal(closeEvent.code, 1000);
        assert.equal(closeEvent.reason, "tunnel_updated");
    } finally {
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
    }
});

test("revocation: severLocalSessions requires both tunnelId and edgeId to match (AND conjunction)", () => {
    let s1Closed = false;
    let s2Closed = false;
    let s3Closed = false;

    registerSession({
        id: "s1",
        tunnelId: "tun_A",
        edgeId: "edg_1",
        close: () => {
            s1Closed = true;
        },
    });

    registerSession({
        id: "s2",
        tunnelId: "tun_A",
        edgeId: "edg_2",
        close: () => {
            s2Closed = true;
        },
    });

    registerSession({
        id: "s3",
        tunnelId: "tun_B",
        edgeId: "edg_1",
        close: () => {
            s3Closed = true;
        },
    });

    // Empty filter should sever nothing
    const countEmpty = severLocalSessions({}, "token_rolled");
    assert.equal(countEmpty, 0);

    // Filter matching both tun_A and edg_1
    const count = severLocalSessions({ tunnelId: "tun_A", edgeId: "edg_1" }, "token_rolled");
    assert.equal(count, 1);
    assert.equal(s1Closed, true, "s1 should have been closed");
    assert.equal(s2Closed, false, "s2 should NOT have been closed");
    assert.equal(s3Closed, false, "s3 should NOT have been closed");

    // Clean up remaining
    severLocalSessions({ tunnelId: "tun_A" });
    severLocalSessions({ tunnelId: "tun_B" });
});
