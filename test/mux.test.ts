import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { MuxSession, type MuxStream } from "../src/mux/session.ts";
import { spliceStreams } from "../src/mux/splice.ts";
import { FRAME_DATA, MAX_DATA_PAYLOAD, STREAM_WINDOW, encodeFrame } from "../src/mux/frames.ts";

// Two ends of an in-memory WebSocket: each send arrives as the other's binary message.
function wsPair() {
    const make = () => {
        const ws: any = new EventEmitter();
        Object.assign(ws, { OPEN: 1, readyState: 1, bufferedAmount: 0 });
        return ws;
    };
    const a = make();
    const b = make();
    a.send = (frame: Buffer) => setImmediate(() => b.emit("message", Buffer.from(frame), true));
    b.send = (frame: Buffer) => setImmediate(() => a.emit("message", Buffer.from(frame), true));
    return [a, b];
}

function sessions() {
    const [a, b] = wsPair();
    const accepted: MuxStream[] = [];
    const opener = new MuxSession(a);
    const acceptor = new MuxSession(b, {
        onOpen: (stream) => {
            stream.opened();
            accepted.push(stream);
        },
    });
    return { opener, acceptor, accepted };
}

function readAll(stream: MuxStream): Promise<Buffer> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        stream.on("data", (d: Buffer) => chunks.push(d));
        stream.once("close", () => resolve(Buffer.concat(chunks)));
    });
}

test("mux: a RESET right after FIN still delivers every byte sent before it", async () => {
    const { opener, accepted } = sessions();
    const stream = await opener.openStream();
    const received = readAll(stream);
    await new Promise((r) => setImmediate(r));
    const peer = accepted[0];

    const payload = crypto.randomBytes(300 * 1024);
    peer.end(payload);
    // the target side closed: FIN, then the RESET that carries the reason
    peer.once("finish", () => {
        peer.closeReason = "target_close";
        peer.destroy();
    });

    assert.ok((await received).equals(payload));
    assert.equal(stream.peerCloseReason, "target_close");
});

test("mux: a RESET before FIN ends the stream at once with the peer's reason", async () => {
    const { opener, accepted } = sessions();
    const stream = await opener.openStream();
    const closed = new Promise((r) => stream.once("close", r));
    stream.resume();
    await new Promise((r) => setImmediate(r));
    accepted[0].closeReason = "target_unreachable";
    accepted[0].destroy();
    await closed;
    assert.equal(stream.peerCloseReason, "target_unreachable");
});

test("mux: large transfers both ways stay within the window and arrive whole", async () => {
    const { opener, accepted } = sessions();
    const stream = await opener.openStream();
    await new Promise((r) => setImmediate(r));
    const peer = accepted[0];
    // the accepting side echoes
    peer.pipe(peer);

    const payload = crypto.randomBytes(2 * 1024 * 1024);
    const chunks: Buffer[] = [];
    let total = 0;
    const done = new Promise<void>((resolve) =>
        stream.on("data", (d: Buffer) => {
            chunks.push(d);
            total += d.length;
            if (total >= payload.length) resolve();
        })
    );
    stream.write(payload);
    await done;
    assert.ok(Buffer.concat(chunks).equals(payload));
    stream.destroy();
});

test("mux: DATA beyond the granted window resets the stream with stream_error", async () => {
    const { opener, accepted } = sessions();
    const stream = await opener.openStream();
    const closed = new Promise((r) => stream.once("close", r));
    stream.resume();
    await new Promise((r) => setImmediate(r));
    const peer = accepted[0];

    // a peer ignoring flow control: one frame past the window, nobody reading on this side
    const chunk = Buffer.alloc(MAX_DATA_PAYLOAD);
    for (let sent = 0; sent <= STREAM_WINDOW; sent += chunk.length) {
        opener.send(encodeFrame(FRAME_DATA, stream.id, chunk));
    }
    await closed;
    assert.equal(stream.peerCloseReason, "stream_error");
    assert.ok(peer.destroyed);
    assert.ok(peer.readableLength <= STREAM_WINDOW, "nothing past the window was buffered");
});

test("mux: spliced sessions deliver a whole response the far side ends with FIN then RESET", async () => {
    // client ↔ hub (runtime leg), hub ↔ edge (relay leg), spliced on the hub like a relayed tunnel;
    // the client reads late, so bytes are still parked on the hub when the edge's RESET lands
    const payload = crypto.randomBytes(400 * 1024);
    const [ra, rb] = wsPair();
    const [rc, rd] = wsPair();
    const relay = new MuxSession(rc);
    let edgeClosed!: () => void;
    const edgeDone = new Promise<void>((r) => (edgeClosed = r));
    new MuxSession(rd, {
        onOpen: (edgeSide) => {
            edgeSide.opened();
            edgeSide.end(payload);
            edgeSide.once("finish", () => {
                edgeSide.closeReason = "target_close";
                edgeSide.destroy();
            });
            edgeSide.once("close", () => edgeClosed());
        },
    });
    const ends: string[] = [];
    new MuxSession(rb, {
        onOpen: async (hubSide) => {
            hubSide.opened();
            const target = await relay.openStream();
            spliceStreams({
                stream: hubSide,
                other: target,
                streamEnd: "client_close",
                otherEnd: "target_close",
                ready: Promise.resolve(),
                onEnd: (reason) => ends.push(reason),
            });
        },
    });
    const client = await new MuxSession(ra).openStream();

    await edgeDone;
    await new Promise((r) => setTimeout(r, 20));
    assert.ok((await readAll(client)).equals(payload), "the whole response arrives");
    assert.equal(client.peerCloseReason, "target_close");
    assert.deepEqual(ends, ["target_close"]);
});
