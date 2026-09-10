import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import * as ws from "ws";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerHook } from "../src/utils/hooks.ts";
import { setupTestServer } from "./helpers.ts";
import * as kv from "../src/kv/index.ts";

const PORT = 3464;
process.env.ALLOW_FILESYSTEM_MULTIWORKER = "1";
await setupTestServer(PORT);

test("Connect-to-Relay least-busy routing bypasses stalled worker with WORKERS=2", async (t) => {
    // 1. Spawn a Stalling TCP Server (accepts connection, never writes or closes)
    let stallingConnectionReceived = false;
    let stallingSocket: net.Socket | null = null;
    const stallingServer = net.createServer((socket) => {
        stallingConnectionReceived = true;
        stallingSocket = socket;
    });
    await new Promise<void>((resolve) =>
        stallingServer.listen(0, "127.0.0.1", resolve),
    );
    const stallingPort = (stallingServer.address() as net.AddressInfo).port;

    // 2. Spawn an Echo TCP Server
    const echoServer = net.createServer((socket) => {
        socket.pipe(socket);
    });
    await new Promise<void>((resolve) =>
        echoServer.listen(0, "127.0.0.1", resolve),
    );
    const echoPort = (echoServer.address() as net.AddressInfo).port;

    // 3. Register Machine on Relay
    const machineRes = await fetch(`http://127.0.0.1:${PORT}/machines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-stalling-workers-machine",
        }),
    });
    assert.strictEqual(machineRes.status, 200);
    const machine = await machineRes.json();
    await kv.set(`machines:${machine.token}`, machine);

    let resolveMachineConnected: () => void;
    let rejectMachineConnected: (err: Error) => void;
    const machineConnectedPromise = new Promise<void>((resolve, reject) => {
        resolveMachineConnected = resolve;
        rejectMachineConnected = reject;
    });

    const connectTimeout = setTimeout(() => {
        rejectMachineConnected(
            new Error("Timed out waiting for machine_connect hook"),
        );
    }, 10000);

    const unregisterHook = registerHook("machine_connect", async (req) => {
        if (req.headers.authorization === machine.token) {
            clearTimeout(connectTimeout);
            resolveMachineConnected();
        }
    });

    // 4. Start Connected-to-Relay machine process with --workers 2
    const childEnv = { ...process.env };
    delete childEnv.QUIET;

    const routedWorkers: number[] = [];
    const connectedProcess = spawn(
        process.execPath,
        [
            "--experimental-strip-types",
            path.resolve("./src/main.ts"),
            "--relay-url",
            `ws://127.0.0.1:${PORT}`,
            "--token",
            machine.token,
            "--workers",
            "2",
            "--reconnect-timeout",
            "200",
        ],
        {
            env: childEnv,
        },
    );

    const waitForRoutedWorkers = async (
        targetCount: number,
        timeoutMs = 5000,
    ) => {
        const start = Date.now();
        while (routedWorkers.length < targetCount) {
            if (Date.now() - start > timeoutMs) {
                throw new Error(
                    `Timed out waiting for ${targetCount} routed workers (currently ${routedWorkers.length})`,
                );
            }
            await new Promise((r) => setTimeout(r, 50));
        }
    };

    connectedProcess.stdout?.on("data", (d) => {
        const str = d.toString();
        console.log(`[worker-out] ${str}`);
        const matches = str.matchAll(/Forwarding message \S+ to worker (\d+)/g);
        for (const m of matches) {
            routedWorkers.push(parseInt(m[1], 10));
        }
    });
    connectedProcess.stderr?.on("data", (d) =>
        console.error(`[worker-err] ${d}`),
    );

    connectedProcess.on("exit", (code) => {
        if (code !== null && code !== 0) {
            clearTimeout(connectTimeout);
            rejectMachineConnected(
                new Error(`Connected machine process exited with code ${code}`),
            );
        }
    });

    let wsStall: ws.WebSocket | null = null;
    let wsEcho1: ws.WebSocket | null = null;
    let wsEcho2: ws.WebSocket | null = null;

    t.after(async () => {
        clearTimeout(connectTimeout);
        unregisterHook();
        wsStall?.close();
        wsEcho1?.close();
        wsEcho2?.close();
        stallingSocket?.destroy();
        connectedProcess.kill("SIGKILL");
        await new Promise<void>((resolve) => {
            if (connectedProcess.exitCode !== null) return resolve();
            connectedProcess.once("exit", () => resolve());
            setTimeout(resolve, 500);
        });
        await new Promise<void>((resolve) =>
            stallingServer.close(() => resolve()),
        );
        await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    });

    await machineConnectedPromise;

    // 5. Register Stalling Relayed Service
    const stallingServiceRes = await fetch(
        `http://127.0.0.1:${PORT}/services`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "test-stalling-service",
                internalHost: "127.0.0.1",
                internalPort: stallingPort,
                machineId: machine.id,
            }),
        },
    );
    assert.strictEqual(stallingServiceRes.status, 200);
    const stallingService = await stallingServiceRes.json();
    await kv.set(`services:${stallingService.token}`, stallingService);

    // 6. Register Echo Relayed Service
    const echoServiceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-echo-service",
            internalHost: "127.0.0.1",
            internalPort: echoPort,
            machineId: machine.id,
        }),
    });
    assert.strictEqual(echoServiceRes.status, 200);
    const echoService = await echoServiceRes.json();
    await kv.set(`services:${echoService.token}`, echoService);

    // 7. Request 1: Connect to Stalling Service (Worker 0 should pick this up and stall)
    wsStall = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: { Authorization: stallingService.token },
    });

    await new Promise<void>((resolve, reject) => {
        wsStall!.on("open", resolve);
        wsStall!.on("error", reject);
    });

    wsStall.send("Stalling request payload");

    // Wait until stalling server receives the backend TCP connection
    for (let i = 0; i < 30; i++) {
        if (stallingConnectionReceived) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
        stallingConnectionReceived,
        "Stalling TCP server never received connection",
    );

    await waitForRoutedWorkers(1);
    const stalledWorkerIndex = routedWorkers[0];
    assert.ok(
        stalledWorkerIndex !== undefined,
        "Request 1 should have been routed to a worker",
    );
    const availableWorkerIndex = (stalledWorkerIndex + 1) % 2;

    // 8. Request 2: While Request 1 is stalled, connect to Echo Service
    wsEcho1 = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: { Authorization: echoService.token },
    });

    await new Promise<void>((resolve, reject) => {
        wsEcho1!.on("open", resolve);
        wsEcho1!.on("error", reject);
    });

    const echo1Promise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Echo 1 round trip timed out")),
            5000,
        );
        wsEcho1!.on("message", (data) => {
            clearTimeout(timeout);
            resolve(data.toString());
        });
        wsEcho1!.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    const echo1Payload = "Echo Request 1 while stalled";
    wsEcho1.send(echo1Payload);
    const echo1Result = await echo1Promise;
    assert.strictEqual(echo1Result, echo1Payload);
    wsEcho1.close();

    await waitForRoutedWorkers(2);
    // Brief delay to ensure IPC request_completed is processed by master
    await new Promise((r) => setTimeout(r, 200));

    // Verify Request 2 was routed to the available worker
    assert.strictEqual(
        routedWorkers[1],
        availableWorkerIndex,
        `Request 2 should have been routed to worker ${availableWorkerIndex}`,
    );

    // 9. Request 3: While Request 1 is STILL stalled, send another Echo request.
    // Under blind round-robin, this would have cycled back to stalledWorkerIndex.
    // Under least-busy, it must go to availableWorkerIndex because stalledWorkerIndex is still busy!
    wsEcho2 = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: { Authorization: echoService.token },
    });

    await new Promise<void>((resolve, reject) => {
        wsEcho2!.on("open", resolve);
        wsEcho2!.on("error", reject);
    });

    const echo2Promise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Echo 2 round trip timed out")),
            5000,
        );
        wsEcho2!.on("message", (data) => {
            clearTimeout(timeout);
            resolve(data.toString());
        });
        wsEcho2!.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    const echo2Payload = "Echo Request 2 while stalled";
    wsEcho2.send(echo2Payload);
    const echo2Result = await echo2Promise;
    assert.strictEqual(echo2Result, echo2Payload);
    wsEcho2.close();

    await waitForRoutedWorkers(3);
    // Brief delay to ensure log capture
    await new Promise((r) => setTimeout(r, 200));

    // Verify Request 3 was ALSO routed to availableWorkerIndex (bypassing stalledWorkerIndex!)
    assert.strictEqual(
        routedWorkers[2],
        availableWorkerIndex,
        `Request 3 should have been routed to least-busy worker ${availableWorkerIndex} instead of stalled worker ${stalledWorkerIndex}`,
    );
});
