import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    createTestEchoServer,
    connectTestWs,
    jsonFetch,
} from "./helpers.ts";

test("direct_tunnel: bidirectional streaming through direct TCP dial", async () => {
    clearHooks();
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("direct-tun-");

    const config = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    try {
        hub = await startHub(config);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Create direct tunnel pointing to TCP echo server
        const createRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Direct Echo Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        assert.equal(createRes.status, 201);
        const token = createRes.data.token;

        let connectedFired = false;
        let endedReason = "";

        registerHook("tunnel_connected", () => {
            connectedFired = true;
        });

        registerHook("tunnel_end", (_req, _tunnel, reason) => {
            endedReason = reason;
        });

        // Connect WebSocket client presenting tunnel token
        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: token },
        });

        // Send binary data and verify echo
        const testPayload = Buffer.from("Hello FullStacked Direct Tunnel!");
        const echoed = await new Promise<Buffer>((resolve) => {
            ws.on("message", (data: Buffer) => {
                resolve(data);
            });
            ws.send(testPayload);
        });

        assert.equal(echoed.toString("utf-8"), testPayload.toString("utf-8"));
        assert.equal(connectedFired, true);

        // Clean close from client
        ws.close(1000, "client_close");
        await new Promise((r) => setTimeout(r, 100));

        assert.ok(endedReason === "client_close" || endedReason === "target_close");
    } finally {
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("direct_tunnel: target unreachable closes with 1014 target_unreachable", async () => {
    clearHooks();
    const deadPort = await getAvailablePort();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("direct-unreach-");

    const config = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    try {
        hub = await startHub(config);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Create direct tunnel pointing to dead port
        const createRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Unreachable Tunnel",
                internalHost: "127.0.0.1",
                internalPort: deadPort,
            },
        });
        const token = createRes.data.token;

        // Connect WebSocket
        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: token },
        });

        const closeEvent = await new Promise<{ code: number; reason: string }>((resolve) => {
            ws.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });

        assert.equal(closeEvent.code, 1014);
        assert.equal(closeEvent.reason, "target_unreachable");
    } finally {
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});
