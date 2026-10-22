import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type WebSocket from "ws";
import { startEdge, type EdgeInstance } from "../src/edge/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { clearHooks } from "../src/utils/hooks.ts";
import {
    getAvailablePort,
    connectTestWs,
    startTestHub,
    createTunnel,
    createEdge,
    jsonFetch,
    waitFor,
    type TestHub,
} from "./helpers.ts";

const PART = Buffer.from("ping!");
const ROUNDS = 20;

/**
 * A target that answers only once both small parts of a request have arrived, like a database
 * reading Parse/Bind/Execute/Sync. With Nagle on the target socket, the second part waits for
 * the ACK of the first, which the target delays (~40 ms) because it has nothing to send yet.
 */
async function createTwoPartServer(): Promise<{ port: number; close: () => Promise<void> }> {
    const port = await getAvailablePort();
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        let received = 0;
        socket.on("data", (chunk) => {
            received += chunk.length;
            while (received >= PART.length * 2) {
                received -= PART.length * 2;
                socket.write("pong");
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    return {
        port,
        close: async () => {
            for (const s of sockets) s.destroy();
            await new Promise<void>((res) => server.close(() => res()));
        },
    };
}

/** Median round trip of two sequential small writes followed by one reply. */
async function medianRoundTrip(ws: WebSocket): Promise<number> {
    const timings: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
        const start = performance.now();
        const reply = new Promise<void>((resolve) => ws.once("message", () => resolve()));
        ws.send(PART);
        ws.send(PART);
        await reply;
        timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    return timings[Math.floor(ROUNDS / 2)];
}

test("nodelay: direct tunnel write-write-read has no Nagle stall", async () => {
    clearHooks();
    const target = await createTwoPartServer();
    let hub: TestHub | null = null;
    let ws: WebSocket | null = null;
    try {
        hub = await startTestHub();
        const tunnel = await createTunnel(hub.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: target.port,
        });
        ws = await connectTestWs(`ws://127.0.0.1:${hub.port}/`, {
            headers: { Authorization: tunnel.token },
        });

        const median = await medianRoundTrip(ws);
        assert.ok(median < 20, `median round trip ${median.toFixed(1)} ms, expected < 20 ms`);
    } finally {
        ws?.close(1000, "client_close");
        if (hub) await hub.close();
        await target.close();
        clearHooks();
    }
});

test("nodelay: relayed tunnel write-write-read has no Nagle stall", async () => {
    clearHooks();
    const target = await createTwoPartServer();
    let hub: TestHub | null = null;
    let edge: EdgeInstance | null = null;
    let ws: WebSocket | null = null;
    try {
        hub = await startTestHub();
        const edgeData = await createEdge(hub.baseUrl);
        edge = await startEdge(
            parseConfig(["--hub-url", `ws://127.0.0.1:${hub.port}`, "--token", edgeData.token])
        );
        const baseUrl = hub.baseUrl;
        await waitFor(
            async () => (await jsonFetch(`${baseUrl}/edges/${edgeData.id}`)).data?.connected
        );

        const tunnel = await createTunnel(hub.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: target.port,
            edgeId: edgeData.id,
        });
        ws = await connectTestWs(`ws://127.0.0.1:${hub.port}/`, {
            headers: { Authorization: tunnel.token },
        });

        const median = await medianRoundTrip(ws);
        assert.ok(median < 20, `median round trip ${median.toFixed(1)} ms, expected < 20 ms`);
    } finally {
        ws?.close(1000, "client_close");
        if (edge) await edge.stop();
        if (hub) await hub.close();
        await target.close();
        clearHooks();
    }
});
