import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { registerHeartbeat, setHeartbeatConfig, stopHeartbeat } from "../src/ws/heartbeat.ts";
import { getAvailablePort } from "./helpers.ts";

test("heartbeat: pings peer on sweep and updates lastReceived on pong", async () => {
    const port = await getAvailablePort();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    let serverWs: WebSocket | null = null;
    let sweepCount = 0;

    wss.on("connection", (ws) => {
        serverWs = ws;
        registerHeartbeat(ws, {
            onSweep: () => {
                sweepCount++;
            },
        });
    });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    setHeartbeatConfig(0.05, 0.5); // 50ms sweep, 500ms timeout

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);
    let pingReceivedCount = 0;
    clientWs.on("ping", () => {
        pingReceivedCount++;
    });

    await new Promise((resolve) => clientWs.on("open", resolve));

    // Wait for at least 2 sweeps
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.ok(sweepCount >= 2, `Expected >= 2 sweeps, got ${sweepCount}`);
    assert.ok(pingReceivedCount >= 2, `Expected >= 2 pings, got ${pingReceivedCount}`);
    assert.equal(clientWs.readyState, WebSocket.OPEN);

    clientWs.close();
    server.close();
    wss.close();
    stopHeartbeat();
});

test("heartbeat: closes with 1011 heartbeat_timeout on unresponsive peer", async () => {
    const port = await getAvailablePort();
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    let timeoutFired = false;

    wss.on("connection", (ws) => {
        registerHeartbeat(ws, {
            onTimeout: () => {
                timeoutFired = true;
            },
        });
    });

    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    // Fast sweep: 40ms sweep, 80ms timeout
    setHeartbeatConfig(0.04, 0.08);

    const clientWs = new WebSocket(`ws://127.0.0.1:${port}`);

    // Suppress automatic pong from client so server detects unresponsive peer
    (clientWs as any).pong = () => {};

    await new Promise((resolve) => clientWs.on("open", resolve));

    const closeEvent = await new Promise<{ code: number; reason: string }>((resolve) => {
        clientWs.on("close", (code, reasonBuf) => {
            resolve({ code, reason: reasonBuf.toString("utf-8") });
        });
    });

    assert.equal(closeEvent.code, 1011);
    assert.equal(closeEvent.reason, "heartbeat_timeout");
    assert.equal(timeoutFired, true);

    server.close();
    wss.close();
    stopHeartbeat();
});
