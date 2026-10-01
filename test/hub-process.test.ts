import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { MemoryKVProvider } from "../src/kv/memory.ts";
import { cleanupWorkerPresence } from "../src/hub/cluster.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    createTestEchoServer,
    connectTestWs,
    jsonFetch,
    waitFor,
    waitForClose,
} from "./helpers.ts";

test("hub-process: worker exit cleanup only removes presence still owned by that worker", async () => {
    const kv = new MemoryKVProvider();
    await kv.set("edge:e1:worker", "boot:2", 60);
    await kv.set("edge:e2:worker", "boot:3", 60); // reconnected elsewhere since
    await kv.sadd("worker:boot:2:edges", "e1");
    await kv.sadd("worker:boot:2:edges", "e2");

    await cleanupWorkerPresence(kv, "boot:2");

    assert.equal(await kv.get("edge:e1:worker"), null);
    assert.equal(await kv.get("edge:e2:worker"), "boot:3");
    assert.deepEqual(await kv.smembers("worker:boot:2:edges"), []);
    await kv.close();
});

function spawnHub(args: string[]): { proc: ChildProcess; output: () => string } {
    const proc = spawn(process.execPath, ["src/main.ts", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout?.on("data", (d) => (out += d));
    proc.stderr?.on("data", (d) => (out += d));
    return { proc, output: () => out };
}

function exitCode(proc: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
}

async function runShutdownScenario(extraArgs: string[], keepSessionOpen: boolean) {
    const echo = await createTestEchoServer();
    const port = await getAvailablePort();
    const dir = createTempDir("hub-proc-");
    const { proc, output } = spawnHub([
        "--port",
        String(port),
        "--data-dir",
        dir,
        "--shutdown-timeout",
        "1",
        ...extraArgs,
    ]);
    const exited = exitCode(proc);
    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        await waitFor(async () => {
            try {
                return (await jsonFetch(`${baseUrl}/tunnels`)).status === 200;
            } catch {
                return false;
            }
        }, 10000).catch(() => assert.fail(`Hub did not start:\n${output()}`));

        const created = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: { name: "t", internalHost: "127.0.0.1", internalPort: echo.port },
        });
        let ws: WebSocket | null = null;
        if (keepSessionOpen) {
            ws = await connectTestWs(`ws://127.0.0.1:${port}/`, {
                headers: { Authorization: created.data.token },
            });
            const echoed = new Promise((r) => ws!.once("message", r));
            ws.send("ping");
            await echoed;
        }
        const closed = ws ? waitForClose(ws) : Promise.resolve(null);

        proc.kill("SIGTERM");
        return { code: await exited, close: await closed, output: output() };
    } finally {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        await echo.close();
        cleanupTempDir(dir);
    }
}

test("hub-process: single-process Hub exits 0 when idle and 1 after force-closing sessions", async () => {
    const idle = await runShutdownScenario([], false);
    assert.equal(idle.code, 0, idle.output);

    const busy = await runShutdownScenario([], true);
    assert.deepEqual(busy.close, { code: 1001, reason: "hub_shutdown" });
    assert.equal(busy.code, 1, busy.output);
});

test("hub-process: clustered workers drain on SIGTERM and the Primary reports their exit code", async () => {
    const args = ["--workers", "2", "--allow-fs-multiworker"];
    const busy = await runShutdownScenario(args, true);
    assert.deepEqual(busy.close, { code: 1001, reason: "hub_shutdown" });
    assert.equal(busy.code, 1, busy.output);

    const idle = await runShutdownScenario(args, false);
    assert.equal(idle.code, 0, idle.output);
});
