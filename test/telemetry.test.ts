import test from "node:test";
import assert from "node:assert/strict";
import type { Duplex } from "node:stream";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import { registerRoute, clearCustomRoutes } from "../src/api/index.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    createTestEchoServer,
    connectTestWs,
    jsonFetch,
} from "./helpers.ts";

test("telemetry: full lifecycle hooks (tunnel_start, tunnel_connected, tunnel_end)", async () => {
    clearHooks();
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("telem-life-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;

    let startCount = 0;
    let connectedCount = 0;
    let endCount = 0;
    let endReason = "";

    registerHook("tunnel_start", () => {
        startCount++;
    });

    registerHook("tunnel_connected", () => {
        connectedCount++;
    });

    registerHook("tunnel_end", (_req, _tunnel, reason) => {
        endCount++;
        endReason = reason;
    });

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        const createRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Telemetry Direct Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        const tunnelToken = createRes.data.token;

        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        // Send a message and wait for echo
        const testPayload = Buffer.from("Hello telemetry!");
        await new Promise<void>((resolve) => {
            ws.on("message", () => resolve());
            ws.send(testPayload);
        });

        assert.equal(startCount, 1);
        assert.equal(connectedCount, 1);
        assert.equal(endCount, 0);

        // Close client ws
        ws.close(1000, "client_close");
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(endCount, 1);
        assert.equal(endReason, "client_close");
    } finally {
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
        clearHooks();
    }
});

test("telemetry: bandwidth accounting and custom /metrics HTTP route", async () => {
    clearHooks();
    clearCustomRoutes();
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("telem-metrics-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;

    let totalIngressBytes = 0;
    let totalEgressBytes = 0;

    // Register bandwidth tracking hook
    registerHook("tunnel_connected", (_req, _tunnel, remoteSocket, targetSocket) => {
        const remote = remoteSocket as Duplex;
        const target = targetSocket as Duplex;

        remote.on("data", (chunk: Buffer) => {
            totalIngressBytes += chunk.length;
        });

        target.on("data", (chunk: Buffer) => {
            totalEgressBytes += chunk.length;
        });
    });

    // Register Prometheus-style /metrics custom route
    registerRoute("/metrics", (_req, res) => {
        const metrics =
            [
                "# HELP tunnels_ingress_bytes Total bytes received from runtime clients",
                "# TYPE tunnels_ingress_bytes counter",
                `tunnels_ingress_bytes ${totalIngressBytes}`,
                "# HELP tunnels_egress_bytes Total bytes sent to runtime clients",
                "# TYPE tunnels_egress_bytes counter",
                `tunnels_egress_bytes ${totalEgressBytes}`,
            ].join("\n") + "\n";

        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        res.end(metrics);
        return true;
    });

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        const createRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Metrics Direct Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        const tunnelToken = createRes.data.token;

        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        const testMsg = Buffer.from("1234567890"); // 10 bytes
        await new Promise<void>((resolve) => {
            ws.on("message", () => resolve());
            ws.send(testMsg);
        });

        // Query /metrics
        const metricsRes = await fetch(`${baseUrl}/metrics`);
        assert.equal(metricsRes.status, 200);
        const text = await metricsRes.text();

        assert.ok(text.includes("tunnels_ingress_bytes 10"));
        assert.ok(text.includes("tunnels_egress_bytes 10"));

        ws.close();
    } finally {
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
        clearHooks();
        clearCustomRoutes();
    }
});
