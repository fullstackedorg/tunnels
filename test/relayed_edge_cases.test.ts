import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import WebSocket from "ws";
import { startHub } from "../src/hub/index.ts";
import { startEdge } from "../src/edge/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { clearHooks } from "../src/utils/hooks.ts";
import { setSaturationLimits } from "../src/warden/orders.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    jsonFetch,
    connectTestWs,
} from "./helpers.ts";

test("relayed_edge_cases: offline edge closes runtime with 1014 edge_disconnected", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("edge-offline-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        // Create an edge first so edgeId validation passes
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Offline Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;

        // Create tunnel referencing offline edge
        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Relayed Tunnel Offline",
                edgeId,
                internalHost: "127.0.0.1",
                internalPort: 8080,
            },
        });
        assert.equal(tunRes.status, 201);
        const token = tunRes.data.token;

        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: token },
        });

        const closeResult = await new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });

        assert.equal(closeResult.code, 1014);
        assert.equal(closeResult.reason, "edge_disconnected");
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("relayed_edge_cases: saturated edge closes runtime with 1013 edge_saturated", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("edge-sat-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    let lifelineWs: WebSocket | null = null;
    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Sat Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edge = edgeRes.data;

        // Connect raw lifeline directly
        lifelineWs = await connectTestWs(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: edge.token },
        });

        // Create tunnel
        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Sat Tunnel",
                edgeId: edge.id,
                internalHost: "127.0.0.1",
                internalPort: 8080,
            },
        });
        assert.equal(tunRes.status, 201);
        const token = tunRes.data.token;

        // Force saturation: maxPendingOrders = 0
        setSaturationLimits(0, 1024 * 1024);

        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: token },
        });

        const closeResult = await new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });

        assert.equal(closeResult.code, 1013);
        assert.equal(closeResult.reason, "edge_saturated");
    } finally {
        setSaturationLimits(100, 1024 * 1024);
        if (lifelineWs) lifelineWs.close();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("relayed_edge_cases: direct connect timeout closes with 1014 connect_timeout", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("direct-timeout-");
    // Connect timeout set to 1 second
    const config = parseConfig([
        "--port",
        String(port),
        "--data-dir",
        tempDir,
        "--connect-timeout",
        "1",
    ]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        // 192.0.2.1 is reserved documentation subnet (TEST-NET-1) which drops packets (times out)
        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Timeout Direct",
                internalHost: "192.0.2.1",
                internalPort: 81,
            },
        });
        assert.equal(tunRes.status, 201);
        const token = tunRes.data.token;

        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: token },
        });

        const closeResult = await new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });

        assert.equal(closeResult.code, 1014);
        assert.equal(closeResult.reason, "connect_timeout");
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("relayed_edge_cases: relayed deadline timeout closes with 1014 connect_timeout", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("relayed-timeout-");
    const config = parseConfig([
        "--port",
        String(port),
        "--data-dir",
        tempDir,
        "--connect-timeout",
        "1",
    ]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Silent Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edge = edgeRes.data;

        // Connect a raw lifeline WebSocket that never answers connect_tunnel order
        const lifelineWs = await connectTestWs(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: edge.token },
        });

        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Silent Tunnel",
                edgeId: edge.id,
                internalHost: "127.0.0.1",
                internalPort: 8080,
            },
        });
        assert.equal(tunRes.status, 201);
        const token = tunRes.data.token;

        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: token },
        });

        const closeResult = await new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });

        assert.equal(closeResult.code, 1014);
        assert.equal(closeResult.reason, "connect_timeout");
        lifelineWs.close();
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("relayed_edge_cases: target clean FIN closes runtime with 1000 target_close", async () => {
    clearHooks();
    const hubPort = await getAvailablePort();
    const targetPort = await getAvailablePort();
    const tempDir = createTempDir("target-close-");

    // TCP target that ends cleanly after receiving first data
    const server = net.createServer((socket) => {
        socket.once("data", () => {
            socket.end();
        });
    });
    await new Promise<void>((r) => server.listen(targetPort, "127.0.0.1", r));

    const config = parseConfig(["--port", String(hubPort), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${hubPort}`;
        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Target Close Tunnel",
                internalHost: "127.0.0.1",
                internalPort: targetPort,
            },
        });
        assert.equal(tunRes.status, 201);
        const token = tunRes.data.token;

        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: token },
        });

        const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });

        ws.send("trigger-fin");
        const closeResult = await closePromise;
        assert.equal(closeResult.code, 1000);
        assert.equal(closeResult.reason, "target_close");
    } finally {
        server.close();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("relayed_edge_cases: target stream error closes runtime with 1011 stream_error", async () => {
    clearHooks();
    const hubPort = await getAvailablePort();
    const targetPort = await getAvailablePort();
    const tempDir = createTempDir("stream-err-");

    // TCP target that resets socket to trigger ECONNRESET stream error
    const server = net.createServer((socket) => {
        socket.on("error", () => {});
        socket.once("data", () => {
            socket.resetAndDestroy();
        });
    });
    await new Promise<void>((r) => server.listen(targetPort, "127.0.0.1", r));

    const config = parseConfig(["--port", String(hubPort), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${hubPort}`;
        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Stream Error Tunnel",
                internalHost: "127.0.0.1",
                internalPort: targetPort,
            },
        });
        assert.equal(tunRes.status, 201);
        const token = tunRes.data.token;

        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: token },
        });

        const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });

        ws.send("trigger-error");
        const closeResult = await closePromise;
        assert.equal(closeResult.code, 1011);
        assert.equal(closeResult.reason, "stream_error");
    } finally {
        server.close();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});
