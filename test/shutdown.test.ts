import test from "node:test";
import assert from "node:assert/strict";
import { startHub } from "../src/hub/index.ts";
import { performHubShutdown } from "../src/hub/shutdown.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerSession } from "../src/tunnels/registry.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    connectTestWs,
    createTestEchoServer,
    jsonFetch,
} from "./helpers.ts";

test("shutdown: clean hub shutdown with no active sessions returns exit code 0", async () => {
    const port = await getAvailablePort();
    const tempDir = createTempDir("shutdown-clean-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const exitCode = await hub.close();
        assert.equal(exitCode, 0);
    } finally {
        cleanupTempDir(tempDir);
    }
});

test("shutdown: clean hub shutdown with sessions draining in time returns exit code 0", async () => {
    const echo = await createTestEchoServer();
    const port = await getAvailablePort();
    const tempDir = createTempDir("shutdown-drain-");
    const config = parseConfig([
        "--port",
        String(port),
        "--data-dir",
        tempDir,
        "--shutdown-timeout",
        "2",
    ]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Drain Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        assert.equal(tunRes.status, 201);
        const token = tunRes.data.token;

        const ws = await connectTestWs(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: token },
        });

        // Close client session shortly after shutdown begins
        setTimeout(() => {
            ws.close(1000, "client_close");
        }, 100);

        const exitCode = await performHubShutdown(hub.server, config, false);
        assert.equal(exitCode, 0);
    } finally {
        await echo.close();
        cleanupTempDir(tempDir);
    }
});

test("shutdown: hub shutdown with lingering session exceeding timeout force-closes with 1001 hub_shutdown and exit code 1", async () => {
    const echo = await createTestEchoServer();
    const port = await getAvailablePort();
    const tempDir = createTempDir("shutdown-timeout-");
    // Short shutdown timeout: 1 second
    const config = parseConfig([
        "--port",
        String(port),
        "--data-dir",
        tempDir,
        "--shutdown-timeout",
        "1",
    ]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Lingering Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
            },
        });
        assert.equal(tunRes.status, 201);
        const token = tunRes.data.token;

        const ws = await connectTestWs(`ws://127.0.0.1:${port}/`, {
            headers: { Authorization: token },
        });

        const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            ws.on("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString() });
            });
        });

        // Do not close client ws - let it linger until timeout force-closes
        const exitCode = await performHubShutdown(hub.server, config, false);
        assert.equal(exitCode, 1);

        const closeResult = await closePromise;
        assert.equal(closeResult.code, 1001);
        assert.equal(closeResult.reason, "hub_shutdown");
    } finally {
        await echo.close();
        cleanupTempDir(tempDir);
    }
});
