import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import {
    cleanupTempDir,
    createTempDir,
    createTestEchoServer,
    getAvailablePort,
    jsonFetch,
    sleep,
    waitFor,
} from "./helpers.ts";
import { connectTunnelClient, type TunnelClient } from "./mux-client.ts";

function spawnNode(args: string[]): { proc: ChildProcess; output: () => string } {
    const proc = spawn(process.execPath, ["src/main.ts", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout?.on("data", (d) => (out += d));
    proc.stderr?.on("data", (d) => (out += d));
    return { proc, output: () => out };
}

async function stop(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
}

/** One runtime connection (its own WebSocket, so the Hub's cluster spreads them over workers). */
async function echoThrough(hubPort: number, token: string, size: number): Promise<void> {
    const client: TunnelClient = await connectTunnelClient(`ws://127.0.0.1:${hubPort}/`, {
        headers: { Authorization: token },
    });
    const payload = crypto.randomBytes(size);
    const chunks: Buffer[] = [];
    let received = 0;
    await new Promise<void>((resolve, reject) => {
        client.on("message", (data) => {
            chunks.push(data);
            received += data.length;
            if (received >= size) resolve();
        });
        client.once("close", (code, reason) => {
            if (received < size) reject(new Error(`closed ${code} ${reason} after ${received}`));
        });
        client.send(payload);
    });
    assert.ok(Buffer.concat(chunks).equals(payload), "echo mismatch");
    client.close();
}

test("cluster-relay: clustered Hub and clustered Edge relay concurrent streams, and survive an Edge worker exit", async () => {
    const echo = await createTestEchoServer();
    const hubPort = await getAvailablePort();
    const dir = createTempDir("cluster-relay-");
    const hub = spawnNode([
        "--port",
        String(hubPort),
        "--data-dir",
        dir,
        "--workers",
        "2",
        "--allow-fs-multiworker",
    ]);
    let edge: ReturnType<typeof spawnNode> | null = null;
    const baseUrl = `http://127.0.0.1:${hubPort}`;

    try {
        await waitFor(async () => {
            try {
                return (await jsonFetch(`${baseUrl}/tunnels`)).status === 200;
            } catch {
                return false;
            }
        }, 10_000);

        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Clustered Relay Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;

        edge = spawnNode([
            "--edge",
            "--hub-url",
            `ws://127.0.0.1:${hubPort}`,
            "--token",
            edgeRes.data.token,
            "--workers",
            "2",
        ]);
        await waitFor(
            async () => (await jsonFetch(`${baseUrl}/edges/${edgeId}`)).data?.connected === true,
            10_000
        );

        const tunnelRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Clustered Relay Tunnel",
                internalHost: "127.0.0.1",
                internalPort: echo.port,
                edgeId,
            },
        });
        assert.equal(tunnelRes.status, 201);
        const token = tunnelRes.data.token;

        // Runtime connections land on both Hub workers; the one without the lifeline asks for
        // its relay sessions through the lifeline worker, and the Edge's sessions are moved to
        // the worker they are dialed for.
        const round = (n: number) =>
            Promise.all(
                Array.from({ length: n }, (_, i) => echoThrough(hubPort, token, 1024 * (1 + i)))
            );
        await round(16);
        await round(16);

        // Relay sessions of one Edge worker drop with it; streams after that get new ones.
        const workers = execFileSync("pgrep", ["-P", String(edge.proc.pid)], { encoding: "utf-8" })
            .trim()
            .split("\n")
            .map(Number)
            .filter(Boolean);
        assert.equal(workers.length, 2, "two Edge workers");
        process.kill(workers[0], "SIGKILL");
        await sleep(300);
        await round(16);

        // A large transfer through each Hub worker
        await Promise.all([
            echoThrough(hubPort, token, 4 * 1024 * 1024),
            echoThrough(hubPort, token, 4 * 1024 * 1024),
        ]);
    } catch (err) {
        console.error(`Hub output:\n${hub.output()}\nEdge output:\n${edge?.output() ?? ""}`);
        throw err;
    } finally {
        if (edge) await stop(edge.proc);
        await stop(hub.proc);
        await echo.close();
        cleanupTempDir(dir);
    }
});
