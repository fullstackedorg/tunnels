import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    createTestEchoServer,
    connectTestWs,
    jsonFetch,
} from "./helpers.ts";

test("edge-workers: clustered edge with 2 workers streams data end-to-end", async () => {
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("edge-cluster-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    let edgeProc: any = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Create Edge entity on Hub
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Clustered Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;
        const edgeToken = edgeRes.data.token;

        // Launch Edge in multi-worker mode (workers = 2)
        edgeProc = spawn(
            process.execPath,
            [
                "src/main.ts",
                "--edge",
                "--hub-url",
                `ws://127.0.0.1:${hubPort}`,
                "--token",
                edgeToken,
                "--workers",
                "2",
            ],
            {
                stdio: ["ignore", "pipe", "pipe"],
            }
        );

        // Wait for Edge lifeline presence
        let connected = false;
        for (let i = 0; i < 60; i++) {
            try {
                const check = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
                if (check.data?.connected) {
                    connected = true;
                    break;
                }
            } catch {}
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(connected, true, "Edge cluster failed to connect lifeline");

        // Create relayed tunnel
        const tunnelRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Clustered Relayed Echo Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
                edgeId,
            },
        });
        assert.equal(tunnelRes.status, 201);
        const tunnelToken = tunnelRes.data.token;

        // Connect runtime client and stream data
        const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: { Authorization: tunnelToken },
        });

        const testPayload = Buffer.from("Hello from Clustered Edge Worker!");
        const echoed = await new Promise<Buffer>((resolve) => {
            ws.on("message", (data: Buffer) => {
                resolve(data);
            });
            ws.send(testPayload);
        });

        assert.equal(echoed.toString("utf-8"), testPayload.toString("utf-8"));

        ws.close(1000, "client_close");
        await new Promise((r) => setTimeout(r, 50));
    } finally {
        if (edgeProc) {
            edgeProc.kill("SIGTERM");
            let exited = false;
            await new Promise((resolve) => {
                edgeProc.once("exit", () => {
                    exited = true;
                    resolve(null);
                });
                setTimeout(() => {
                    if (!exited) {
                        try {
                            edgeProc.kill("SIGKILL");
                        } catch {}
                    }
                    resolve(null);
                }, 2000);
            });
        }
        if (hub) await hub.close();
        await echo.close();
        cleanupTempDir(dir);
    }
});
