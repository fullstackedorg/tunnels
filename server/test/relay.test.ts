import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import * as ws from "ws";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerHook } from "../src/utils/hooks.ts";
import { setupTestServer } from "./helpers.ts";

const PORT = 3460;
await setupTestServer(PORT);

test("Relay e2e round-trip - relay process & connected-to-relay machine process", async () => {
    // 1. Spawn a TCP Echo server for the machine to connect to locally
    let receivedDataByEchoServer = false;
    const socketServer = net.createServer((socket) => {
        socket.on("data", () => {
            receivedDataByEchoServer = true;
        });
        socket.pipe(socket);
    });
    await new Promise<void>((resolve) => socketServer.listen(0, resolve));
    const echoPort = (socketServer.address() as net.AddressInfo).port;

    // 2. Register a Machine on the Relay server
    const machineRes = await fetch(`http://127.0.0.1:${PORT}/machines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-relay-machine-e2e",
        }),
    });
    assert.strictEqual(
        machineRes.status,
        200,
        "Machine creation on Relay server failed",
    );
    const machine = await machineRes.json();
    assert.ok(machine.id, "Machine ID missing");
    assert.ok(machine.token, "Machine token missing");

    // Prepare machine_connect hook promise with timeout and exit safety
    let resolveMachineConnected: () => void;
    let rejectMachineConnected: (err: Error) => void;
    const machineConnectedPromise = new Promise<void>((resolve, reject) => {
        resolveMachineConnected = resolve;
        rejectMachineConnected = reject;
    });

    const connectTimeout = setTimeout(() => {
        rejectMachineConnected(
            new Error(`Timed out waiting for machine_connect hook`),
        );
    }, 5000);

    registerHook("machine_connect", async (req) => {
        if (req.headers.authorization === machine.token) {
            clearTimeout(connectTimeout);
            resolveMachineConnected();
        }
    });

    // 3. Start a Connected-to-Relay machine process via child_process.spawn
    const connectedProcess = spawn(process.execPath, [
        "--experimental-strip-types",
        path.resolve("./src/main.ts"),
        "--relay-url",
        `ws://127.0.0.1:${PORT}`,
        "--token",
        machine.token,
    ]);

    connectedProcess.on("exit", (code) => {
        if (code !== null && code !== 0) {
            clearTimeout(connectTimeout);
            rejectMachineConnected(
                new Error(`Connected machine process exited with code ${code}`),
            );
        }
    });

    // Wait for machine_connect hook to trigger when machine connects its lifeline
    await machineConnectedPromise;

    try {
        // 4. Register a Relayed Service on the Relay server associated with machine.id
        const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "test-relayed-service-e2e",
                internalHost: "127.0.0.1",
                internalPort: echoPort,
                machineId: machine.id,
                workerCount: 1,
            }),
        });

        assert.strictEqual(
            serviceRes.status,
            200,
            "Relayed service creation failed",
        );
        const service = await serviceRes.json();
        assert.ok(service.token, "Relayed service token missing");

        // 5. Client connects via WebSocket to the Relay server using the service token
        const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
            headers: { Authorization: service.token },
        });

        await new Promise<void>((resolve, reject) => {
            wsClient.on("open", resolve);
            wsClient.on("error", reject);
        });

        // 6. Pass data round-trip through Relay -> Connected-to-Relay Machine -> Local Echo Server
        const testPayload =
            "Hello, Relay & Connected-to-Relay Machine Round-Trip Test!";
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

        // 7. Verify assertions
        assert.strictEqual(
            echoResult,
            testPayload,
            "Echoed data through relay must match original payload",
        );
        assert.ok(
            receivedDataByEchoServer,
            "Local TCP echo server should have received the data",
        );

        wsClient.close();
    } finally {
        connectedProcess.kill();
        await new Promise<void>((resolve) =>
            socketServer.close(() => resolve()),
        );
    }
});
