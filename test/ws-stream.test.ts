import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import * as ws from "ws";
import { Writable } from "node:stream";
import {
    coalesceFrameWrites,
    createWsDuplex,
    performSymmetricalTeardown,
} from "../src/utils/ws-stream.ts";

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

test("ws-stream: coalesceFrameWrites hands the frames of one read to the target in one write", async () => {
    const server = http.createServer();
    const wss = new ws.WebSocketServer({ noServer: true });
    // Each entry is one _write / _writev call on the target, with the chunks it carried.
    const writes: string[][] = [];
    const target = new Writable({
        write(chunk, _enc, cb) {
            writes.push([chunk.toString()]);
            cb();
        },
        writev(chunks, cb) {
            writes.push(chunks.map((c) => c.chunk.toString()));
            cb();
        },
    });
    let received = 0;
    target.on("pipe", (src) => src.on("data", () => received++));

    server.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (client) => {
            const duplex = createWsDuplex(client);
            coalesceFrameWrites(client, target);
            duplex.pipe(target);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const clientWs = new ws.WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => clientWs.on("open", resolve));

    try {
        // Four frames in one TCP write, so the server reads them at once.
        const socket = (clientWs as any)._socket;
        socket.cork();
        for (const part of ["parse", "bind", "execute", "sync"]) clientWs.send(part);
        socket.uncork();
        const deadline = Date.now() + 2000;
        while (received < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(writes, [["parse", "bind", "execute", "sync"]]);

        // A later frame is written on its own (the target is uncorked again).
        clientWs.send("next");
        while (received < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(writes.at(-1), ["next"]);
    } finally {
        clientWs.terminate();
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
