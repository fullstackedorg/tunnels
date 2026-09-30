import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { startHub } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import { registerWebSocketRoute, clearWebSocketRoutes } from "../src/http/index.ts";
import { createWebSocketServer } from "../src/ws/index.ts";
import { createTicket, cancelTicketTombstone } from "../src/warden/tickets.ts";
import { kv, setKV } from "../src/kv/index.ts";
import { getAvailablePort, createTempDir, cleanupTempDir, connectTestWs } from "./helpers.ts";

function makeUpgradeRequest(
    port: number,
    path: string,
    headers: Record<string, string> = {}
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            path,
            headers: {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
                "Sec-WebSocket-Version": "13",
                ...headers,
            },
        });
        req.on("response", (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body,
                });
            });
        });
        req.on("error", reject);
        req.end();
    });
}

test("ingress upgrade: missing Authorization header returns 401 Unauthorized", async () => {
    clearHooks();
    clearWebSocketRoutes();
    const port = await getAvailablePort();
    const tempDir = createTempDir("ingress-upgrade-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const res = await makeUpgradeRequest(port, "/");
        assert.equal(res.statusCode, 401);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.error, "Unauthorized");
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("ingress upgrade: unknown token prefix returns 401 Unauthorized", async () => {
    clearHooks();
    clearWebSocketRoutes();
    const port = await getAvailablePort();
    const tempDir = createTempDir("ingress-upgrade-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const res = await makeUpgradeRequest(port, "/", {
            Authorization: "invalid_prefix_token",
        });
        assert.equal(res.statusCode, 401);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.error, "Unauthorized");
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("ingress upgrade: non-root upgrade path without custom route returns 404 Not Found", async () => {
    clearHooks();
    clearWebSocketRoutes();
    const port = await getAvailablePort();
    const tempDir = createTempDir("ingress-upgrade-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const res = await makeUpgradeRequest(port, "/unknown/subpath", {
            Authorization: "tun_validtokenformat12345",
        });
        assert.equal(res.statusCode, 404);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.error, "Not Found");
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("ingress upgrade: custom WebSocket route via registerWebSocketRoute", async () => {
    clearHooks();
    clearWebSocketRoutes();
    const port = await getAvailablePort();
    const tempDir = createTempDir("ingress-upgrade-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    const unreg = registerWebSocketRoute("/custom-ws", (req, socket, head) => {
        const wss = createWebSocketServer();
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send("welcome-custom-route");
        });
    });

    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/custom-ws`);
        const msg = await new Promise<string>((resolve, reject) => {
            ws.once("message", (data) => resolve(data.toString()));
            ws.once("error", reject);
        });
        assert.equal(msg, "welcome-custom-route");
        ws.close();
    } finally {
        unreg();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("ingress upgrade: hub_upgrade hook denial returns 500 on throw", async () => {
    clearHooks();
    clearWebSocketRoutes();
    registerHook("hub_upgrade", () => {
        throw new Error("Upgrade hook simulated crash");
    });

    const port = await getAvailablePort();
    const tempDir = createTempDir("ingress-upgrade-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const res = await makeUpgradeRequest(port, "/");
        assert.equal(res.statusCode, 500);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.error, "Internal Server Error");
    } finally {
        clearHooks();
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("ingress upgrade: token resolution failure returns 503 Service Unavailable", async () => {
    clearHooks();
    clearWebSocketRoutes();
    const port = await getAvailablePort();
    const tempDir = createTempDir("ingress-upgrade-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    const failingKV = {
        get: async () => {
            throw new Error("Simulated KV failure");
        },
    } as any;
    setKV(failingKV);

    try {
        const res = await makeUpgradeRequest(port, "/", {
            Authorization: "tun_somethingsomething",
        });
        assert.equal(res.statusCode, 503);
        const parsed = JSON.parse(res.body);
        assert.equal(parsed.error, "Service Unavailable");
    } finally {
        setKV(null);
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("ingress upgrade: cancelled ticket tombstone immediately closes with close code and reason", async () => {
    clearHooks();
    clearWebSocketRoutes();
    const port = await getAvailablePort();
    const tempDir = createTempDir("ingress-upgrade-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const ticket = await createTicket(
            "origin-1",
            "lifeline-1",
            "edge-dummy",
            "req-1",
            "tun-1",
            30
        );
        await cancelTicketTombstone(ticket, "connect_timeout");

        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
            headers: { Authorization: ticket },
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
