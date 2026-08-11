import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import * as ws from "ws";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = 3463;
const testDataDir = path.resolve(`./test-data-dir-${PORT}`);
process.env.DATA_DIR = testDataDir;

const kv = await import("../src/kv/index");
const warden = await import("../src/warden/index");
import type { Machine } from "../src/entities/schema/machine";
import type { Service } from "../src/entities/schema/service";

test("Warden KV lifeline registration and lookup", async () => {
    const machineId = "test-warden-machine-" + Date.now();
    const machineToken = "test-token-" + Date.now();
    const machine: Machine = {
        id: machineId,
        token: machineToken,
        name: "test-machine",
        version: "1.0.0",
    };

    // Initially machine is not connected
    const initialConnected = await warden.isMachineConnected(machine);
    assert.strictEqual(initialConnected, false);

    // Simulate set in KV (as done by lifelineRequest)
    await kv.set(`machine_lifeline_${machine.id}`, 1);

    // Now isMachineConnected should return true from KV
    const connectedAfterKV = await warden.isMachineConnected(machine);
    assert.strictEqual(connectedAfterKV, true);

    // Clean up
    await kv.del(`machine_lifeline_${machine.id}`);
    const connectedAfterDel = await warden.isMachineConnected(machine);
    assert.strictEqual(connectedAfterDel, false);
});

test("Warden getRelayedService throws if machine not connected in KV", async () => {
    const service: Service = {
        id: "test-service-id",
        name: "test-service",
        token: "service-token",
        internalHost: "127.0.0.1",
        internalPort: 8080,
        machineId: "non-existent-machine-id",
    };

    await assert.rejects(
        async () => {
            await warden.getRelayedService(service);
        },
        {
            name: "Error",
            message: "Machine is not connected",
        },
    );
});

test("Warden multi-worker KV lifeline and parent IPC routing e2e", async () => {
    // 1. Spawn a TCP Echo server for the machine to connect to
    let receivedDataByEchoServer = false;
    const socketServer = net.createServer((socket) => {
        socket.on("data", () => {
            receivedDataByEchoServer = true;
        });
        socket.pipe(socket);
    });
    await new Promise<void>((resolve) => socketServer.listen(0, resolve));
    const echoPort = (socketServer.address() as net.AddressInfo).port;

    // 2. Spawn Relay Server with --workers 2 using ALLOW_FILESYSTEM_MULTIWORKER=1
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (!k.startsWith("NODE_")) {
            cleanEnv[k] = v;
        }
    }
    process.env.DATA_DIR = testDataDir;
    cleanEnv.DATA_DIR = testDataDir;
    cleanEnv.QUIET = "1";
    cleanEnv.ALLOW_FILESYSTEM_MULTIWORKER = "1";

    const relayProcess = spawn(
        process.execPath,
        [
            "-r",
            "@nitrogql/esbuild-register",
            path.resolve("./src/main.ts"),
            "--port",
            PORT.toString(),
            "--workers",
            "2",
        ],
        {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
            env: cleanEnv,
        },
    );

    relayProcess.stdout?.on("data", (d) => console.log(`[relay-out] ${d}`));
    relayProcess.stderr?.on("data", (d) => console.error(`[relay-err] ${d}`));

    // Wait for server to start listening
    let serverReady = false;
    for (let i = 0; i < 20; i++) {
        try {
            await fetch(`http://127.0.0.1:${PORT}/machines`);
            serverReady = true;
            break;
        } catch {
            await new Promise((r) => setTimeout(r, 250));
        }
    }
    assert.ok(serverReady, "Relay server failed to start");

    let connectedMachineProcess: any = null;

    try {
        // 3. Register Machine on Relay server
        const machineRes = await fetch(`http://127.0.0.1:${PORT}/machines`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "test-warden-multi-worker-machine",
            }),
        });
        assert.strictEqual(machineRes.status, 200, "Machine creation failed");
        const machine = await machineRes.json();
        assert.ok(machine.id, "Machine ID missing");
        assert.ok(machine.token, "Machine token missing");
        await kv.set(`machines:${machine.token}`, machine);

        // 4. Start Connected-to-Relay machine process
        const machineEnv = { ...cleanEnv };
        delete machineEnv.WORKERS;

        connectedMachineProcess = spawn(
            process.execPath,
            [
                "-r",
                "@nitrogql/esbuild-register",
                path.resolve("./src/main.ts"),
                "--relay-url",
                `ws://127.0.0.1:${PORT}`,
                "--token",
                machine.token,
            ],
            {
                env: machineEnv,
            },
        );

        connectedMachineProcess.stdout?.on("data", (d: any) =>
            console.log(`[machine-out] ${d}`),
        );
        connectedMachineProcess.stderr?.on("data", (d: any) =>
            console.error(`[machine-err] ${d}`),
        );

        // Wait for machine lifeline to connect
        await new Promise((r) => setTimeout(r, 3000));

        // 5. Register Relayed Service
        const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "test-warden-relayed-service",
                internalHost: "127.0.0.1",
                internalPort: echoPort,
                machineId: machine.id,
            }),
        });

        assert.strictEqual(
            serviceRes.status,
            200,
            "Relayed service creation failed",
        );
        const service = await serviceRes.json();
        assert.ok(service.token, "Service token missing");
        await kv.set(`services:${service.token}`, service);

        // 6. Connect multiple clients back-to-back to stress test worker routing
        for (let i = 0; i < 3; i++) {
            const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
                headers: { Authorization: service.token },
            });

            await new Promise<void>((resolve, reject) => {
                wsClient.on("open", resolve);
                wsClient.on("error", reject);
            });

            const testPayload = `Warden Multi Worker Payload #${i}`;
            const responsePromise = new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error("Relayed round trip timed out")),
                    5000,
                );
                wsClient.on("message", (data) => {
                    clearTimeout(timeout);
                    resolve(data.toString());
                });
                wsClient.on("error", (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });

            wsClient.send(testPayload);
            const echoResult = await responsePromise;

            assert.strictEqual(echoResult, testPayload);
            wsClient.close();
        }

        assert.ok(receivedDataByEchoServer);
    } finally {
        connectedMachineProcess?.kill("SIGKILL");
        relayProcess?.kill("SIGKILL");
        await new Promise<void>((resolve) =>
            socketServer.close(() => resolve()),
        );
        await fs.promises
            .rm(testDataDir, { recursive: true, force: true })
            .catch(() => {});
    }
});
