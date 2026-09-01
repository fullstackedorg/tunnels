import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import net from "node:net";
import * as ws from "ws";
import { registerHook } from "../src/utils/hooks.ts";
import { setupTestServer } from "./helpers.ts";

const PORT = 3462;
await setupTestServer(PORT);

test("Tunnel service - data metering via tunnel_service hook without losing bytes", async () => {
    let serviceIncomingBytes = 0;
    let serviceOutgoingBytes = 0;

    registerHook("tunnel_service", async (_req, _service, duplex, socket) => {
        duplex.on("data", (chunk: Buffer) => {
            serviceIncomingBytes += chunk.length;
        });
        socket.on("data", (chunk: Buffer) => {
            serviceOutgoingBytes += chunk.length;
        });
    });

    // 1. Spawn a TCP socket server (Echo server)
    const socketServer = net.createServer((socket) => {
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
            name: "metering-test-service",
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

    // 4. Send payload of exact known size (50,000 bytes)
    const payloadSize = 50000;
    const testPayload = Buffer.alloc(payloadSize, 0xab);

    const receivedChunks: Buffer[] = [];
    let totalReceivedBytes = 0;

    const responsePromise = new Promise<Buffer>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Round trip timed out")),
            5000,
        );

        wsClient.on("message", (data: Buffer) => {
            const buf = Buffer.from(data);
            receivedChunks.push(buf);
            totalReceivedBytes += buf.length;

            if (totalReceivedBytes >= payloadSize) {
                clearTimeout(timeout);
                resolve(Buffer.concat(receivedChunks));
            }
        });

        wsClient.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    wsClient.send(testPayload);
    const echoResult = await responsePromise;

    // 5. Verify data integrity and byte counting
    assert.strictEqual(
        echoResult.length,
        payloadSize,
        "Echoed payload length must match sent payload size",
    );
    assert.deepStrictEqual(
        echoResult,
        testPayload,
        "Echoed data content must match original payload",
    );

    // Verify hook metered exact bytes without loss
    assert.strictEqual(
        serviceIncomingBytes,
        payloadSize,
        "Incoming bytes metered by tunnel_service hook must equal sent payload size",
    );
    assert.strictEqual(
        serviceOutgoingBytes,
        payloadSize,
        "Outgoing bytes metered by tunnel_service hook must equal echoed payload size",
    );

    // Cleanup
    wsClient.close();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
});

test("Tunnel proxy - data metering via tunnel_proxy hook without losing bytes", async () => {
    let proxyIncomingBytes = 0;
    let proxyOutgoingBytes = 0;

    registerHook("tunnel_proxy", async (_req, _proxy, res) => {
        _req.on("data", (chunk: Buffer) => {
            proxyIncomingBytes += chunk.length;
        });

        const originalWrite = res.write;
        const originalEnd = res.end;

        res.write = function (chunk: any, ...args: any[]) {
            if (chunk) {
                const len =
                    typeof chunk === "string"
                        ? Buffer.byteLength(chunk)
                        : chunk.length;
                proxyOutgoingBytes += len;
            }
            return originalWrite.apply(res, [chunk, ...args] as any);
        };

        res.end = function (chunk?: any, ...args: any[]) {
            if (chunk && typeof chunk !== "function") {
                const len =
                    typeof chunk === "string"
                        ? Buffer.byteLength(chunk)
                        : chunk.length;
                proxyOutgoingBytes += len;
            }
            return originalEnd.apply(res, [chunk, ...args] as any);
        };
    });

    // 1. Spawn a target HTTP server to echo request body with fixed response payload
    const responsePayloadSize = 30000;
    const expectedResponseBody = Buffer.alloc(
        responsePayloadSize,
        "X",
    ).toString();

    const targetServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            res.writeHead(200, {
                "Content-Type": "text/plain",
                "Content-Length":
                    Buffer.byteLength(expectedResponseBody).toString(),
            });
            res.end(expectedResponseBody);
        });
    });

    await new Promise<void>((resolve) => targetServer.listen(0, resolve));
    const targetPort = (targetServer.address() as net.AddressInfo).port;

    // 2. Register proxy via HTTP API
    const proxyRes = await fetch(`http://127.0.0.1:${PORT}/proxies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "metering-test-proxy",
            urlProtocol: "http",
            urlHost: "127.0.0.1",
            urlPort: targetPort,
            workerCount: 1,
        }),
    });

    assert.strictEqual(proxyRes.status, 200, "Proxy creation failed");
    const proxy = await proxyRes.json();
    assert.ok(proxy.token, "Proxy token missing");

    // 3. Send POST request through proxy with payload of exact known size (20,000 bytes)
    const requestPayloadSize = 20000;
    const postPayload = Buffer.alloc(requestPayloadSize, "A").toString();

    const res = await fetch(`http://127.0.0.1:${PORT}/meter-test`, {
        method: "POST",
        headers: {
            Authorization: proxy.token,
            "Content-Type": "text/plain",
        },
        body: postPayload,
    });

    assert.strictEqual(res.status, 200, "Proxy POST request failed");
    const responseText = await res.text();

    assert.strictEqual(
        responseText.length,
        responsePayloadSize,
        "Proxy response length must match target response payload size",
    );

    // Verify hook metered exact bytes without loss
    assert.strictEqual(
        proxyIncomingBytes,
        requestPayloadSize,
        "Incoming bytes metered by tunnel_proxy hook must equal request payload size",
    );
    assert.strictEqual(
        proxyOutgoingBytes,
        responsePayloadSize,
        "Outgoing bytes metered by tunnel_proxy hook must equal response payload size",
    );

    // Cleanup
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
});
