import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import * as ws from "ws";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerHook } from "../src/utils/hooks";
import { setupTestServer } from "./helpers";

const PORT = 3461;
await setupTestServer(PORT);

test("Relay e2e round-trip - with WORKERS=2", async () => {
    // 1. Spawn a TCP Echo server
    let receivedDataByEchoServer = false;
    const socketServer = net.createServer((socket) => {
        socket.on("data", () => {
            receivedDataByEchoServer = true;
        });
        socket.pipe(socket);
    });
    await new Promise<void>((resolve) => socketServer.listen(0, resolve));
    const echoPort = (socketServer.address() as net.AddressInfo).port;

    // 2. Register Machine
    const machineRes = await fetch(`http://127.0.0.1:${PORT}/machines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-relay-machine-workers",
        }),
    });
    assert.strictEqual(machineRes.status, 200);
    const machine = await machineRes.json();

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

    // 3. Start Connected-to-Relay machine process with --workers 2
    const connectedProcess = spawn(process.execPath, [
        "-r",
        "@nitrogql/esbuild-register",
        path.resolve("./src/main.ts"),
        "--relay-url",
        `ws://127.0.0.1:${PORT}`,
        "--token",
        machine.token,
        "--workers",
        "2",
    ]);

    connectedProcess.stdout?.on("data", (d) =>
        console.log(`[worker-out] ${d}`),
    );
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

    await machineConnectedPromise;

    try {
        // 4. Register Relayed Service
        const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "test-relayed-service-workers",
                internalHost: "127.0.0.1",
                internalPort: echoPort,
                machineId: machine.id,
            }),
        });

        assert.strictEqual(serviceRes.status, 200);
        const service = await serviceRes.json();

        // 5. Client connects via WS
        const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
            headers: { Authorization: service.token },
        });

        await new Promise<void>((resolve, reject) => {
            wsClient.on("open", resolve);
            wsClient.on("error", reject);
        });

        // 6. Pass data round-trip
        const testPayload = "Hello Workers Round-Trip!";
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
        assert.ok(receivedDataByEchoServer);

        wsClient.close();
    } finally {
        connectedProcess.kill("SIGKILL");
        await new Promise<void>((resolve) =>
            socketServer.close(() => resolve()),
        );
    }
});
