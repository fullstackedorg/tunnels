import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import * as ws from "ws";
import { setupTestServer } from "./helpers.ts";

const PORT = 3456;
await setupTestServer(PORT);

test("Tunnel service round-trip socket piping e2e - string payload", async () => {
    // 1. Spawn a TCP socket server (Echo server)
    let receivedDataBySocketServer = false;
    const socketServer = net.createServer((socket) => {
        socket.on("data", () => {
            receivedDataBySocketServer = true;
        });
        socket.pipe(socket);
    });

    await new Promise<void>((resolve) => socketServer.listen(0, resolve));
    const socketAddress = socketServer.address() as net.AddressInfo;
    const socketPort = socketAddress.port;

    // 2. Register service via HTTP API
    const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-echo-service-string",
            internalHost: "127.0.0.1",
            internalPort: socketPort,
            workerCount: 1,
        }),
    });

    assert.strictEqual(serviceRes.status, 200, "Service creation failed");
    const service = await serviceRes.json();
    assert.ok(service.token, "Service token missing");

    // 3. Connect via WebSocket through the tunnel server
    const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: {
            Authorization: service.token,
        },
    });

    await new Promise<void>((resolve, reject) => {
        wsClient.on("open", resolve);
        wsClient.on("error", reject);
    });

    // 4. Pass data round trip
    const testPayload = "Hello, Tunnel Service E2E Test!";
    const responsePromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Round trip timed out")),
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

    // 5. Verify assertions
    assert.strictEqual(
        echoResult,
        testPayload,
        "Echoed data must match original string payload",
    );
    assert.ok(
        receivedDataBySocketServer,
        "TCP socket server should have received the string data",
    );

    // Cleanup
    wsClient.close();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
});

test("Tunnel service round-trip socket piping e2e - binary buffer payload", async () => {
    // 1. Spawn a TCP socket server (Echo server)
    let receivedDataBySocketServer = false;
    const socketServer = net.createServer((socket) => {
        socket.on("data", () => {
            receivedDataBySocketServer = true;
        });
        socket.pipe(socket);
    });

    await new Promise<void>((resolve) => socketServer.listen(0, resolve));
    const socketAddress = socketServer.address() as net.AddressInfo;
    const socketPort = socketAddress.port;

    // 2. Register service via HTTP API
    const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-echo-service-binary",
            internalHost: "127.0.0.1",
            internalPort: socketPort,
            workerCount: 1,
        }),
    });

    assert.strictEqual(serviceRes.status, 200, "Service creation failed");
    const service = await serviceRes.json();
    assert.ok(service.token, "Service token missing");

    // 3. Connect via WebSocket through the tunnel server
    const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: {
            Authorization: service.token,
        },
    });

    await new Promise<void>((resolve, reject) => {
        wsClient.on("open", resolve);
        wsClient.on("error", reject);
    });

    // 4. Pass binary buffer round trip
    const testPayload = Buffer.from([
        0x01, 0x02, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef,
    ]);
    const responsePromise = new Promise<Buffer>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Round trip timed out")),
            5000,
        );
        wsClient.on("message", (data: Buffer) => {
            clearTimeout(timeout);
            resolve(Buffer.from(data));
        });
        wsClient.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    wsClient.send(testPayload);

    const echoResult = await responsePromise;

    // 5. Verify assertions
    assert.deepStrictEqual(
        echoResult,
        testPayload,
        "Echoed data must match original binary payload",
    );
    assert.ok(
        receivedDataBySocketServer,
        "TCP socket server should have received the binary data",
    );

    // Cleanup
    wsClient.close();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
});
