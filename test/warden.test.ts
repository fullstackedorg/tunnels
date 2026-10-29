import test from "node:test";
import assert from "node:assert/strict";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { kv } from "../src/kv/index.ts";
import { EventEmitter } from "node:events";
import {
    closeRelays,
    configureRelays,
    pickRelay,
    placeStream,
    probeRelays,
    registerRelay,
    RELAY_STALE_BUSY_MS,
    RELAY_STALE_MS,
    RELAY_SUSPECT_MS,
    relayRequestFailed,
    suspectRelays,
    waitForRelay,
} from "../src/warden/relays.ts";
import { openRelayedStream } from "../src/warden/index.ts";
import { MAX_STREAMS_PER_RELAY } from "../src/constants.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    connectTestWs,
    jsonFetch,
} from "./helpers.ts";

// Enough of a ws WebSocket for a relay session that only opens streams; it answers pings like a
// live Edge until `silent` (a path that dropped it without a close).
function fakeRelayWs() {
    const ws: any = new EventEmitter();
    Object.assign(ws, {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        silent: false,
        pings: 0,
        sent: [] as Buffer[],
        send(frame: Buffer) {
            ws.sent.push(frame);
        },
        ping(data?: Buffer) {
            ws.pings++;
            if (!ws.silent) queueMicrotask(() => ws.emit("pong", data ?? Buffer.alloc(0)));
        },
        close() {
            ws.readyState = 3;
            ws.emit("close", 1000, Buffer.from("client_close"));
        },
        terminate() {
            ws.close();
        },
    });
    return ws;
}

test("warden: relay placement spreads streams, waits for a spare, skips clogged sessions", async () => {
    const requests: string[] = [];
    configureRelays({ request: (id) => requests.push(id), keepWarm: () => false });
    const edge = "edge-place-1";
    const open = async () => {
        const relay = await placeStream(edge, Date.now() + 5000);
        relay.session.startStream();
        relay.reserved--;
        return relay;
    };

    assert.equal(pickRelay(edge), undefined);
    const r1 = registerRelay(edge, fakeRelayWs());

    // the idle session takes the stream; taking the last idle one asks for a spare ahead
    assert.equal(await open(), r1);
    assert.equal(requests.length, 1);

    // every session busy: the stream waits for the one dialed for it
    const waiting = open();
    await new Promise((r) => setImmediate(r));
    assert.equal(requests.length, 2, "one more asked for this stream");
    const r2 = registerRelay(edge, fakeRelayWs());
    assert.equal(await waiting, r2, "the spare that came up is its own");

    // a third session comes up idle: the next stream takes it at once
    const r3 = registerRelay(edge, fakeRelayWs());
    assert.equal(await open(), r3);

    // r1 carries one stream, r2 and r3 one each; a backed-up r1 is skipped by the fallback pick
    (r1.ws as any).bufferedAmount = 1024 * 1024;
    r1.queuedSince = Date.now() - 1000;
    r2.session.startStream();
    r3.session.startStream();
    assert.notEqual(pickRelay(edge), r1);
    (r1.ws as any).bufferedAmount = 0;
    assert.equal(pickRelay(edge), r1);

    // a round trip grown past twice its best is clogged too
    r1.rttMin = 10;
    r1.rttSmooth = 80;
    assert.notEqual(pickRelay(edge), r1);

    assert.equal(closeRelays(edge, "edge_deleted"), 3);
    assert.equal(pickRelay(edge), undefined);
});

test("warden: streams wait for a relay session until it comes, fails, or the deadline", async () => {
    configureRelays({ request: () => {}, keepWarm: () => false });
    const edge = "edge-wait-1";

    await assert.rejects(waitForRelay(edge, Date.now() + 50), (r) => r === "connect_timeout");

    const failed = waitForRelay(edge, Date.now() + 5000);
    relayRequestFailed(edge);
    await assert.rejects(failed, (r) => r === "relay_dial_failed");

    const abort = new AbortController();
    const aborted = waitForRelay(edge, Date.now() + 5000, abort.signal);
    abort.abort("client_aborted");
    await assert.rejects(aborted, (r) => r === "client_aborted");

    const arrived = waitForRelay(edge, Date.now() + 5000);
    registerRelay(edge, fakeRelayWs());
    await arrived;
    closeRelays(edge, "edge_deleted");
});

test("warden: a relayed stream opens with the target in its OPEN, or edge_saturated when full", async () => {
    configureRelays({ request: () => {}, keepWarm: () => false });
    const edge = "edge-open-1";
    const ws = fakeRelayWs();
    const relay = registerRelay(edge, ws);
    const tunnel: any = {
        id: "t1",
        name: "n",
        internalHost: "10.0.0.5",
        internalPort: 5432,
        edgeId: edge,
        metadata: {},
    };
    const req: any = { id: "s.1", clientIp: "203.0.113.1" };

    const opening = openRelayedStream(tunnel, req, Date.now() + 1000);
    await new Promise((r) => setImmediate(r));
    const open = ws.sent.at(-1) as Buffer;
    assert.equal(open[0], 1, "an OPEN frame");
    const payload = JSON.parse(open.subarray(5).toString("utf-8"));
    assert.equal(payload.tunnel.internalHost, "10.0.0.5");
    assert.equal(payload.tunnel.internalPort, 5432);
    assert.ok(payload.connectTimeoutMs > 0 && payload.connectTimeoutMs <= 1000);
    // the Edge refuses: RESET with its reason
    const id = open.readUInt32BE(1);
    const reset = Buffer.concat([Buffer.from([6, 0, 0, 0, 0]), Buffer.from("target_unreachable")]);
    reset.writeUInt32BE(id, 1);
    ws.emit("message", reset, true);
    await assert.rejects(opening, (e: any) => e.reason === "target_unreachable");

    for (let i = relay.session.size; i < MAX_STREAMS_PER_RELAY; i++) relay.session.startStream();
    // full, and no spare comes: edge_saturated
    await assert.rejects(
        openRelayedStream(tunnel, req, Date.now() + 3000),
        (e: any) => e.reason === "edge_saturated"
    );
    closeRelays(edge, "edge_deleted");
});

test("warden: a relay session dropping before OPENED fails the stream with edge_disconnected", async () => {
    configureRelays({ request: () => {}, keepWarm: () => false });
    const edge = "edge-drop-1";
    const ws = fakeRelayWs();
    registerRelay(edge, ws);
    const tunnel: any = { id: "t1", name: "n", internalHost: "h", internalPort: 1, edgeId: edge };
    const req: any = { id: "s.2", clientIp: "203.0.113.1" };

    const opening = openRelayedStream(tunnel, req, Date.now() + 1000);
    await new Promise((r) => setImmediate(r));
    // the Edge's WebSocket drops without a close reason, no target was ever dialed
    ws.readyState = 3;
    ws.emit("close", 1006, Buffer.alloc(0));
    await assert.rejects(opening, (e: any) => e.reason === "edge_disconnected");
    closeRelays(edge, "edge_deleted");
});

test("warden: a relay session cut without a close is skipped after a second and dropped after three", async () => {
    const requests: string[] = [];
    configureRelays({ request: (id) => requests.push(id), keepWarm: () => false });
    const edge = "edge-silent-1";
    const ws = fakeRelayWs();
    const relay = registerRelay(edge, ws);
    const ago = (ms: number) => Date.now() - ms;

    // idle sessions are pinged too, and an answer clears the probe
    probeRelays();
    assert.equal(ws.pings, 1);
    assert.ok(relay.probeSince > 0);
    await new Promise((r) => queueMicrotask(() => r(null)));
    assert.equal(relay.probeSince, 0);

    // the path drops it silently: picked while the ping is young, skipped past RELAY_SUSPECT_MS
    ws.silent = true;
    probeRelays();
    assert.equal(pickRelay(edge), relay);
    relay.probeSince = ago(RELAY_SUSPECT_MS);
    assert.equal(pickRelay(edge), undefined);

    // data from the Edge proves it alive, also while its pong waits behind that data
    const reset = Buffer.from([6, 0, 0, 0x30, 0x39]);
    ws.emit("message", reset, true);
    assert.equal(relay.probeSince, 0);
    assert.equal(pickRelay(edge), relay);

    // data queued ahead of the ping: only a long silence counts
    relay.probeSince = ago(RELAY_STALE_MS);
    ws.bufferedAmount = 64 * 1024;
    probeRelays();
    assert.equal(ws.readyState, 1);
    relay.probeSince = ago(RELAY_STALE_BUSY_MS);
    probeRelays();
    assert.equal(ws.readyState, 3, "silent past RELAY_STALE_BUSY_MS while busy");

    // nothing queued: dropped at RELAY_STALE_MS, without waiting for a close handshake
    const ws2 = fakeRelayWs();
    const relay2 = registerRelay(edge, ws2);
    ws2.silent = true;
    relay2.probeSince = ago(RELAY_STALE_MS);
    probeRelays();
    assert.equal(ws2.readyState, 3);
    assert.equal(pickRelay(edge), undefined);
    closeRelays(edge, "edge_deleted");
});

test("warden: a new lifeline makes the Edge's relay sessions wait for a pong, and asks for a fresh one", async () => {
    const requests: string[] = [];
    configureRelays({ request: (id) => requests.push(id), keepWarm: () => false });
    const edge = "edge-suspect-1";
    const ws = fakeRelayWs();
    const relay = registerRelay(edge, ws);
    assert.equal(pickRelay(edge), relay);

    suspectRelays(edge);
    assert.equal(ws.pings, 1, "pinged at once");
    assert.equal(pickRelay(edge), undefined, "not picked before it answers");
    assert.deepEqual(requests, [edge], "a fresh session asked for");
    await new Promise((r) => queueMicrotask(() => r(null)));
    assert.equal(pickRelay(edge), relay, "picked again once it answers");

    // an Edge with no session here yet: one is asked for, as before
    suspectRelays("edge-suspect-2");
    assert.deepEqual(requests, [edge, "edge-suspect-2"]);
    closeRelays(edge, "edge_deleted");
});

test("warden: lifeline connection, presence in KV, and superseding older lifeline", async () => {
    const hubPort = await getAvailablePort();
    const dir = createTempDir("warden-life-");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // 1. Create edge
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Warden Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;
        const edgeToken = edgeRes.data.token;

        // 2. Connect first lifeline
        const ws1 = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: {
                Authorization: edgeToken,
                version: "1.0.0",
            },
        });

        // Verify presence in KV
        let workerKey = await kv.get<string>(`edge:${edgeId}:worker`);
        assert.ok(workerKey);
        let lastSeen = await kv.get<number>(`edge:${edgeId}:last_seen`);
        assert.ok(lastSeen && lastSeen > 0);

        // Verify edge status via REST API returns connected: true
        const check1 = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
        assert.equal(check1.data.connected, true);
        assert.equal(check1.data.version, "1.0.0");

        // 3. Connect second lifeline for same edge -> supersedes ws1
        const ws1ClosePromise = new Promise<{ code: number; reason: string }>((resolve) => {
            ws1.once("close", (code, reasonBuf) => {
                resolve({ code, reason: reasonBuf.toString("utf-8") });
            });
        });

        const ws2 = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
            headers: {
                Authorization: edgeToken,
                version: "1.1.0",
            },
        });

        const ws1Close = await ws1ClosePromise;
        assert.equal(ws1Close.code, 1000);
        assert.equal(ws1Close.reason, "superseded");

        // ws2 should be open and presence intact
        assert.equal(ws2.readyState, ws2.OPEN);

        // Clean close ws2
        ws2.close(1000, "normal_close");
    } finally {
        if (hub) await hub.close();
        cleanupTempDir(dir);
    }
});
