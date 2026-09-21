import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import * as ws from "ws";
import path from "node:path";
import { spawn } from "node:child_process";
import cluster from "node:cluster";
import { registerHook } from "../src/utils/hooks.ts";
import { onMessage, notifyRequestCompleted } from "../src/connect.ts";
import { setupTestServer } from "./helpers.ts";

const PORT = 3460;
await setupTestServer(PORT);

test("Relay e2e round-trip - relay process & connected-to-relay machine process", async (t) => {
    // 1. Spawn a TCP Echo server for the machine to connect to locally
    let receivedDataByEchoServer = false;
    const socketServer = net.createServer((socket) => {
        socket.on("data", () => {
            receivedDataByEchoServer = true;
        });
        socket.pipe(socket);
    });
    await new Promise<void>((resolve) =>
        socketServer.listen(0, "127.0.0.1", resolve),
    );
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
    }, 10000);

    const unregisterHook = registerHook("machine_connect", async (req) => {
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
        "--reconnect-timeout",
        "200",
    ]);

    connectedProcess.on("exit", (code) => {
        if (code !== null && code !== 0) {
            clearTimeout(connectTimeout);
            rejectMachineConnected(
                new Error(`Connected machine process exited with code ${code}`),
            );
        }
    });

    let wsClient: ws.WebSocket | null = null;
    t.after(async () => {
        clearTimeout(connectTimeout);
        unregisterHook();
        wsClient?.close();
        connectedProcess.kill("SIGKILL");
        await new Promise<void>((resolve) => {
            if (connectedProcess.exitCode !== null) return resolve();
            connectedProcess.once("exit", () => resolve());
            setTimeout(resolve, 500);
        });
        await new Promise<void>((resolve) =>
            socketServer.close(() => resolve()),
        );
    });

    // Wait for machine_connect hook to trigger when machine connects its lifeline
    await machineConnectedPromise;
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
    wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: { Authorization: service.token },
    });

    await new Promise<void>((resolve, reject) => {
        wsClient!.on("open", resolve);
        wsClient!.on("error", reject);
    });

    // 6. Pass data round-trip through Relay -> Connected-to-Relay Machine -> Local Echo Server
    const testPayload =
        "Hello, Relay & Connected-to-Relay Machine Round-Trip Test!";
    const responsePromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Relayed round trip timed out")),
            5000,
        );
        wsClient!.on("message", (data) => {
            clearTimeout(timeout);
            resolve(data.toString());
        });
        wsClient!.on("error", (err) => {
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
});

test("Connected-to-Relay onMessage cancels execution if reqId is missing", async (t) => {
    let capturedError = "";
    const unregisterLog = registerHook("log", (_, entry) => {
        if (entry.level === "error" && entry.message?.includes("reqId")) {
            capturedError = entry.message;
        }
    });
    t.after(() => {
        unregisterLog();
    });

    let hookCalled = false;
    const unregisterHook = registerHook("machine_service_request", () => {
        hookCalled = true;
    });
    t.after(() => {
        unregisterHook();
    });

    // Message without reqId
    const messageNoReqId = JSON.stringify({
        token: "test-token",
        service: {
            id: "s1",
            name: "service-1",
            internalHost: "127.0.0.1",
            internalPort: 9999,
        },
    });

    await onMessage(messageNoReqId);

    assert.strictEqual(
        hookCalled,
        false,
        "machine_service_request should not be called when reqId is missing",
    );
    assert.match(capturedError, /has no reqId, canceling execution/);
});

test("notifyRequestCompleted logs unexpected issues on IPC errors or missing reqId", (t) => {
    const logs: { level: string; message: string }[] = [];
    const unregisterLog = registerHook("log", (_, entry) => {
        if (entry.message?.includes("notifyRequestCompleted")) {
            logs.push({ level: entry.level, message: entry.message });
        }
    });
    t.after(() => {
        unregisterLog();
    });

    const origIsWorker = cluster.isWorker;
    const origSend = process.send;
    const origConnected = (process as any).connected;
    const restore = () => {
        (cluster as any).isWorker = origIsWorker;
        if (origSend === undefined) {
            delete (process as any).send;
        } else {
            process.send = origSend;
        }
        if (origConnected === undefined) {
            delete (process as any).connected;
        } else {
            (process as any).connected = origConnected;
        }
    };

    try {
        // Mock worker mode
        (cluster as any).isWorker = true;

        // 1. Missing reqId in worker process
        notifyRequestCompleted(null);
        assert.ok(
            logs.some((l) => l.level === "error" && l.message.includes("without reqId")),
            "Should log error when reqId is missing in worker process",
        );

        // 2. Missing process.send in worker process
        delete (process as any).send;
        notifyRequestCompleted("test-req-no-send");
        assert.ok(
            logs.some((l) => l.level === "error" && l.message.includes("process.send is not available")),
            "Should log error when process.send is missing in worker process",
        );

        // 3. IPC disconnected
        (process as any).send = () => true;
        (process as any).connected = false;
        notifyRequestCompleted("test-req-disc");
        assert.ok(
            logs.some((l) => l.level === "warn" && l.message.includes("IPC channel disconnected")),
            "Should log warn when IPC channel is disconnected",
        );

        // 4. process.send throws exception
        (process as any).connected = true;
        (process as any).send = () => {
            throw new Error("channel broken");
        };
        notifyRequestCompleted("test-req-err");
        assert.ok(
            logs.some((l) => l.level === "warn" && l.message.includes("exception sending IPC message")),
            "Should log warn when process.send throws",
        );

        // 5. In single-process mode (isWorker = false), should silently return without logging
        logs.length = 0;
        (cluster as any).isWorker = false;
        notifyRequestCompleted("test-single-process");
        assert.strictEqual(
            logs.length,
            0,
            "Should silently return in single-process mode without logging",
        );
    } finally {
        restore();
    }
});


