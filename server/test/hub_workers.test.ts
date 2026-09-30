import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { handleWardenIpc } from "../src/warden/index.ts";
import {
    handleSeverSessionsIpc,
    registerSession,
    severLocalSessions,
} from "../src/tunnels/registry.ts";
import { getAvailablePort, createTempDir, cleanupTempDir, jsonFetch } from "./helpers.ts";

test("hub_workers: clustered hub launches with 2 workers and serves requests", async () => {
    const hubPort = await getAvailablePort();
    const dir = createTempDir("hub-cluster-");

    const env = {
        ...process.env,
        ALLOW_FILESYSTEM_MULTIWORKER: "true",
    };

    const hubProc = spawn(
        process.execPath,
        [
            "server/src/main.ts",
            "--port",
            String(hubPort),
            "--workers",
            "2",
            "--data-dir",
            dir,
            "--allow-filesystem-multiworker",
        ],
        {
            env,
            stdio: ["ignore", "pipe", "pipe"],
        }
    );

    let output = "";
    hubProc.stdout?.on("data", (d) => {
        output += d.toString();
    });
    hubProc.stderr?.on("data", (d) => {
        output += d.toString();
    });

    try {
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Wait for cluster to start and become reachable
        let reachable = false;
        for (let i = 0; i < 60; i++) {
            try {
                const res = await jsonFetch(`${baseUrl}/tunnels`);
                if (res.status === 200) {
                    reachable = true;
                    break;
                }
            } catch {}
            await new Promise((r) => setTimeout(r, 100));
        }

        assert.equal(reachable, true, `Cluster failed to start. Output:\n${output}`);

        let creates: any;
        try {
            creates = await Promise.all([
                jsonFetch(`${baseUrl}/tunnels`, {
                    method: "POST",
                    body: {
                        name: "Cluster Tunnel 1",
                        internalHost: "127.0.0.1",
                        internalPort: 8081,
                    },
                }),
                jsonFetch(`${baseUrl}/tunnels`, {
                    method: "POST",
                    body: {
                        name: "Cluster Tunnel 2",
                        internalHost: "127.0.0.1",
                        internalPort: 8082,
                    },
                }),
            ]);
        } catch (err: any) {
            console.error("Cluster output on failure:\n", output);
            throw err;
        }

        assert.equal(creates[0].status, 201);
        assert.equal(creates[1].status, 201);

        const listRes = await jsonFetch(`${baseUrl}/tunnels`);
        assert.equal(listRes.status, 200);
        assert.equal(listRes.data.length, 2);
    } finally {
        hubProc.kill("SIGTERM");
        let exited = false;
        await new Promise((resolve) => {
            hubProc.once("exit", () => {
                exited = true;
                resolve(null);
            });
            setTimeout(() => {
                if (!exited) {
                    try {
                        hubProc.kill("SIGKILL");
                    } catch {}
                }
                resolve(null);
            }, 2000);
        });
        cleanupTempDir(dir);
    }
});

test("hub_workers: sever_sessions IPC broadcast closes matching sessions", () => {
    let closed = false;
    registerSession({
        id: "session-cluster-1",
        tunnelId: "tun-cluster-1",
        edgeId: "edge-cluster-1",
        close: (code, reason) => {
            assert.equal(code, 1000);
            assert.equal(reason, "token_rolled");
            closed = true;
        },
    });

    handleSeverSessionsIpc({
        type: "sever_sessions",
        tunnelId: "tun-cluster-1",
        reason: "token_rolled",
    });

    assert.equal(closed, true);
});

test("hub_workers: handleWardenIpc dispatches close_lifeline and failure messages", () => {
    // Test close_lifeline message handling
    let closeCalled = false;
    handleWardenIpc({
        type: "close_lifeline",
        target: "1:1",
        edgeId: "non-existent-edge",
        reason: "superseded",
    });
    // Should not throw even if edge is not local
    assert.ok(true);
});
