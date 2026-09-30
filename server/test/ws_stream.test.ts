import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as ws from "ws";
import { createWsDuplex, performSymmetricalTeardown } from "../src/utils/ws-stream.ts";

test("ws-stream: createWsDuplex creates bidirectional duplex stream", async (t) => {
    const server = http.createServer();
    const wss = new ws.WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (client) => {
            const serverDuplex = createWsDuplex(client);
            serverDuplex.on("data", (chunk: Buffer) => {
                serverDuplex.write(Buffer.from(`echo:${chunk.toString()}`));
            });
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const clientWs = new ws.WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => clientWs.on("open", resolve));

    const clientDuplex = createWsDuplex(clientWs);

    const received = await new Promise<string>((resolve) => {
        clientDuplex.on("data", (chunk: Buffer) => {
            resolve(chunk.toString());
        });
        clientDuplex.write(Buffer.from("hello world"));
    });

    assert.strictEqual(received, "echo:hello world");

    // Symmetrical teardown test
    let teardownDone = false;
    performSymmetricalTeardown({
        ws: clientWs,
        duplex: clientDuplex,
        reason: "client_close",
        onTeardownComplete: () => {
            teardownDone = true;
        },
    });

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(teardownDone, true);
    assert.strictEqual(clientDuplex.destroyed, true);

    clientWs.close();
    wss.close();
    server.close();
});
