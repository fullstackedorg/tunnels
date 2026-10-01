import test from "node:test";
import assert from "node:assert/strict";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { startEdge, type EdgeInstance } from "../src/edge/index.ts";
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

test("relayed-tunnel: end-to-end relayed data streaming through Edge lifeline", async () => {
    clearHooks();
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("relayed-tun-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    let edge: EdgeInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // 1. Create edge on Hub
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Office Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;
        const edgeToken = edgeRes.data.token;

        // 2. Start Edge daemon connecting to Hub
        const edgeConfig = parseConfig([
            "--hub-url",
            `ws://127.0.0.1:${hubPort}`,
            "--token",
            edgeToken,
        ]);
        edge = await startEdge(edgeConfig);

        // Wait for Edge lifeline presence
        let connected = false;
        for (let i = 0; i < 50; i++) {
            const check = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
            if (check.data?.connected) {
                connected = true;
                break;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(connected, true, "Edge failed to establish lifeline");

        // 3. Create relayed tunnel
        const tunnelRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Relayed Echo Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
                edgeId,
            },
        });
        assert.equal(tunnelRes.status, 201);
        const tunnelToken = tunnelRes.data.token;

        let edgeTunnelStartFired = false;
        let edgeTunnelConnectedFired = false;

        registerHook("edge_tunnel_start", () => {
            edgeTunnelStartFired = true;
        });

        registerHook("edge_tunnel_connected", () => {
            edgeTunnelConnectedFired = true;
        });

        // 4. Connect runtime WebSocket client
        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        // Send binary data and verify echo
        const testPayload = Buffer.from("Hello from Relayed Tunnel!");
        const echoed = await new Promise<Buffer>((resolve) => {
            ws.on("message", (data: Buffer) => {
                resolve(data);
            });
            ws.send(testPayload);
        });

        assert.equal(echoed.toString("utf-8"), testPayload.toString("utf-8"));
        assert.equal(edgeTunnelStartFired, true);
        assert.equal(edgeTunnelConnectedFired, true);

        // Clean close
        ws.close(1000, "client_close");
        await new Promise((r) => setTimeout(r, 100));
    } finally {
        if (edge) await edge.stop();
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("relayed-tunnel: target dial failure before handoff sends 1014 target_unreachable", async () => {
    clearHooks();
    const deadPort = await getAvailablePort();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("relayed-unreach-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    let edge: EdgeInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Create edge
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Fail Edge" },
        });
        const edgeId = edgeRes.data.id;
        const edgeToken = edgeRes.data.token;

        // Start edge daemon
        const edgeConfig = parseConfig([
            "--hub-url",
            `ws://127.0.0.1:${hubPort}`,
            "--token",
            edgeToken,
        ]);
        edge = await startEdge(edgeConfig);

        // Wait for presence
        for (let i = 0; i < 50; i++) {
            const check = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
            if (check.data?.connected) break;
            await new Promise((r) => setTimeout(r, 50));
        }

        // Create tunnel with dead port
        const tunnelRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Dead Target Tunnel",
                internalHost: "127.0.0.1",
                internalPort: deadPort,
                edgeId,
            },
        });
        const tunnelToken = tunnelRes.data.token;

        // Connect client
        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        const closeEvent = await new Promise<{ code: number; reason: string }>((resolve) => {
            ws.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });

        assert.equal(closeEvent.code, 1014);
        assert.equal(closeEvent.reason, "target_unreachable");
    } finally {
        if (edge) await edge.stop();
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("relayed-tunnel: edge gating hook denial returns hook_denied and error returns hook_error", async () => {
    clearHooks();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("relayed-hook-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    let edge: EdgeInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Hook Test Edge" },
        });
        const edgeId = edgeRes.data.id;
        const edgeToken = edgeRes.data.token;

        const edgeConfig = parseConfig([
            "--hub-url",
            `ws://127.0.0.1:${hubPort}`,
            "--token",
            edgeToken,
        ]);
        edge = await startEdge(edgeConfig);

        for (let i = 0; i < 50; i++) {
            const check = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
            if (check.data?.connected) break;
            await new Promise((r) => setTimeout(r, 50));
        }

        const tunnelRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Hook Tunnel",
                internalHost: "127.0.0.1",
                internalPort: 8080,
                edgeId,
            },
        });
        const tunnelToken = tunnelRes.data.token;

        // 1. Gating hook denial (calls context.deny())
        registerHook("edge_tunnel_request", (context: any) => {
            context.deny();
        });

        const wsDeny = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });
        const denyClose = await new Promise<{ code: number; reason: string }>((resolve) => {
            wsDeny.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });
        assert.equal(denyClose.code, 1008);
        assert.equal(denyClose.reason, "hook_denied");

        // 2. Gating hook throw/error
        clearHooks();
        registerHook("edge_tunnel_request", () => {
            throw new Error("Simulated hook crash");
        });

        const wsErr = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });
        const errClose = await new Promise<{ code: number; reason: string }>((resolve) => {
            wsErr.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });
        assert.equal(errClose.code, 1011);
        assert.equal(errClose.reason, "hook_error");
    } finally {
        if (edge) await edge.stop();
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("relayed-tunnel: cancel_tunnel order cancels in-flight dial and emits edge_tunnel_end", async () => {
    clearHooks();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("relayed-cancel-");

    const hubConfig = parseConfig([
        "--port",
        String(hubPort),
        "--data-dir",
        dir,
        "--connect-timeout",
        "5",
    ]);

    let hub: HubInstance | null = null;
    let edge: EdgeInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Cancel Edge" },
        });
        const edgeId = edgeRes.data.id;
        const edgeToken = edgeRes.data.token;

        const edgeConfig = parseConfig([
            "--hub-url",
            `ws://127.0.0.1:${hubPort}`,
            "--token",
            edgeToken,
        ]);
        edge = await startEdge(edgeConfig);

        for (let i = 0; i < 50; i++) {
            const check = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
            if (check.data?.connected) break;
            await new Promise((r) => setTimeout(r, 50));
        }

        // Target pointing to non-routable IP that will not complete dial immediately
        const tunnelRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Hanging Target Tunnel",
                internalHost: "192.0.2.1",
                internalPort: 80,
                edgeId,
            },
        });
        const tunnelToken = tunnelRes.data.token;

        let edgeTunnelEndReason = "";
        registerHook("edge_tunnel_end", (_context: any, _tunnel: any, reason: string) => {
            edgeTunnelEndReason = reason;
        });

        // Client connects then immediately terminates socket before handoff
        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        // Terminate client socket while setup is in-flight
        ws.terminate();

        // Wait for cancel_tunnel order to reach Edge and edge_tunnel_end to fire
        for (let i = 0; i < 50; i++) {
            if (edgeTunnelEndReason) break;
            await new Promise((r) => setTimeout(r, 50));
        }

        assert.equal(edgeTunnelEndReason, "client_aborted");
    } finally {
        if (edge) await edge.stop();
        if (hub) await hub.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});
