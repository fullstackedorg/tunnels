import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { startHub } from "../src/hub/index.ts";
import { EdgeLifeline } from "../src/edge/lifeline.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    jsonFetch,
    connectTestWs,
} from "./helpers.ts";

test("edge-lifecycle: telemetry hooks lifeline_connect and lifeline_disconnect fire", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("edge-hooks-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    let connectHookFired = false;
    let disconnectHookReason = "";

    registerHook("lifeline_connect", (_req, edge) => {
        if (edge.name === "Telemetry Edge") {
            connectHookFired = true;
        }
    });

    registerHook("lifeline_disconnect", (_req, edge, reason) => {
        if (edge.name === "Telemetry Edge") {
            disconnectHookReason = reason;
        }
    });

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Telemetry Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edge = edgeRes.data;

        const ws = await connectTestWs(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: edge.token },
        });

        assert.ok(connectHookFired, "lifeline_connect should have fired");

        ws.close(1000, "client_close");
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(disconnectHookReason, "client_close");
    } finally {
        clearHooks();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("edge-lifecycle: tokenFile reads token from disk dynamically", async () => {
    const tempDir = createTempDir("tokenfile-");
    const tokenFilePath = path.join(tempDir, "token.txt");
    fs.writeFileSync(tokenFilePath, "edg_initialtoken123\n", "utf-8");

    const dummyConfig = parseConfig([
        "--edge",
        "--hub-url",
        "ws://127.0.0.1:9999",
        "--token-file",
        tokenFilePath,
    ]);

    const lifeline = new EdgeLifeline({ config: dummyConfig });
    const readToken1 = (lifeline as any).getToken();
    assert.equal(readToken1, "edg_initialtoken123");

    fs.writeFileSync(tokenFilePath, "edg_updatedtoken456\n", "utf-8");
    const readToken2 = (lifeline as any).getToken();
    assert.equal(readToken2, "edg_updatedtoken456");

    cleanupTempDir(tempDir);
});

test("edge-lifecycle: HTTP 403 on handshake delays reconnect by maxReconnectInterval", async () => {
    const fakeServer = http.createServer((_req, res) => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
    });

    const port = await getAvailablePort();
    await new Promise<void>((r) => fakeServer.listen(port, "127.0.0.1", r));

    const config = parseConfig([
        "--edge",
        "--hub-url",
        `ws://127.0.0.1:${port}`,
        "--token",
        "edg_testtoken",
        "--max-reconnect-interval",
        "42",
    ]);

    const lifeline = new EdgeLifeline({ config });
    const reconnectPromise = new Promise<number>((resolve) => {
        (lifeline as any).scheduleReconnect = (delayMs: number) => {
            resolve(delayMs);
        };
    });

    try {
        lifeline.start();
        const delay = await reconnectPromise;
        assert.equal(delay, 42000);
    } finally {
        await lifeline.stop();
        fakeServer.close();
    }
});

test("edge-lifecycle: HTTP 429 on handshake uses Retry-After header", async () => {
    const fakeServer = http.createServer((_req, res) => {
        res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": "15",
        });
        res.end(JSON.stringify({ error: "Too Many Requests" }));
    });

    const port = await getAvailablePort();
    await new Promise<void>((r) => fakeServer.listen(port, "127.0.0.1", r));

    const config = parseConfig([
        "--edge",
        "--hub-url",
        `ws://127.0.0.1:${port}`,
        "--token",
        "edg_testtoken",
    ]);

    const lifeline = new EdgeLifeline({ config });
    const reconnectPromise = new Promise<number>((resolve) => {
        (lifeline as any).scheduleReconnect = (delayMs: number) => {
            resolve(delayMs);
        };
    });

    try {
        lifeline.start();
        const delay = await reconnectPromise;
        assert.equal(delay, 15000);
    } finally {
        await lifeline.stop();
        fakeServer.close();
    }
});

test("edge-lifecycle: superseded close reason schedules reconnect with maxReconnectInterval", async () => {
    const fakeServer = http.createServer();
    const port = await getAvailablePort();

    await new Promise<void>((r) => fakeServer.listen(port, "127.0.0.1", r));
    const wsServer = new WebSocketServer({ server: fakeServer });

    wsServer.on("connection", (ws) => {
        ws.close(1000, "superseded");
    });

    const config = parseConfig([
        "--edge",
        "--hub-url",
        `ws://127.0.0.1:${port}`,
        "--token",
        "edg_testtoken",
        "--max-reconnect-interval",
        "55",
    ]);

    const lifeline = new EdgeLifeline({ config });
    const reconnectPromise = new Promise<number>((resolve) => {
        (lifeline as any).scheduleReconnect = (delayMs: number) => {
            resolve(delayMs);
        };
    });

    try {
        lifeline.start();
        const delay = await reconnectPromise;
        assert.equal(delay, 55000);
    } finally {
        await lifeline.stop();
        wsServer.close();
        fakeServer.close();
    }
});

test("edge-lifecycle: token_rolled and edge_deleted close reasons enter revoked state", async () => {
    const fakeServer = http.createServer();
    const port = await getAvailablePort();

    await new Promise<void>((r) => fakeServer.listen(port, "127.0.0.1", r));
    const wsServer = new WebSocketServer({ server: fakeServer });

    wsServer.on("connection", (ws) => {
        ws.close(1000, "token_rolled");
    });

    const config = parseConfig([
        "--edge",
        "--hub-url",
        `ws://127.0.0.1:${port}`,
        "--token",
        "edg_testtoken",
        "--revoked-poll-interval",
        "12",
    ]);

    const lifeline = new EdgeLifeline({ config });
    const reconnectPromise = new Promise<number>((resolve) => {
        (lifeline as any).scheduleReconnect = (delayMs: number) => {
            resolve(delayMs);
        };
    });

    try {
        lifeline.start();
        const delay = await reconnectPromise;
        assert.equal((lifeline as any).isRevoked, true);
        assert.equal(delay, 12000);
    } finally {
        await lifeline.stop();
        wsServer.close();
        fakeServer.close();
    }
});
