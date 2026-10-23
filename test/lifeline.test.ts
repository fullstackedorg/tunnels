import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { initKV, setKV, kv } from "../src/kv/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { logger } from "../src/utils/logger.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import { handleWardenIpc, setWardenClusterIpcSender } from "../src/warden/index.ts";
import { getLocalLifeline } from "../src/warden/lifeline.ts";
import { MAX_WS_PAYLOAD } from "../src/ws/index.ts";
import {
    SpyKV,
    connectRawLifeline,
    connectTestWs,
    createEdge,
    createTunnel,
    jsonFetch,
    sleep,
    startTestHub,
    waitFor,
    waitForClose,
} from "./helpers.ts";
import { connectTunnelClient, tunnelClient } from "./mux-client.ts";

test("lifeline: a superseded lifeline never unregisters its replacement on the same worker", async () => {
    clearHooks();
    const h = await startTestHub();
    try {
        const edge = await createEdge(h.baseUrl);
        const first = await connectRawLifeline(h.port, edge.token);
        const firstClosed = waitForClose(first.ws);
        const second = await connectRawLifeline(h.port, edge.token);

        assert.deepEqual(await firstClosed, { code: 1000, reason: "superseded" });
        await sleep(200);

        assert.ok(getLocalLifeline(edge.id), "replacement lifeline must stay registered");
        assert.equal(await kv.get(`edge:${edge.id}:worker`), logger.getWorkerIdentity());
        const res = await jsonFetch(`${h.baseUrl}/edges/${edge.id}`);
        assert.equal(res.data.connected, true);

        // Orders reach the replacement lifeline: it is asked for a warm relay session too.
        await waitFor(() => second.orders.some((o) => o.type === "open_relay"));
        assert.deepEqual(
            second.orders.find((o) => o.type === "open_relay"),
            { type: "open_relay", worker: logger.getWorkerIdentity() }
        );
        second.ws.close();
    } finally {
        await h.close();
    }
});

test("lifeline: relay requests from other workers reach the Edge, its failures go back", async () => {
    clearHooks();
    const h = await startTestHub();
    const sent: any[] = [];
    try {
        const edge = await createEdge(h.baseUrl);
        const lifeline = await connectRawLifeline(h.port, edge.token);
        await waitFor(() => Boolean(getLocalLifeline(edge.id)));
        setWardenClusterIpcSender((msg) => sent.push(msg));

        handleWardenIpc({
            type: "relay_request",
            target: logger.getWorkerIdentity(),
            edgeId: edge.id,
            worker: "other:2",
        });
        await waitFor(() => lifeline.orders.some((o) => o.worker === "other:2"), 1000);
        assert.deepEqual(lifeline.orders.at(-1), { type: "open_relay", worker: "other:2" });

        lifeline.ws.send(JSON.stringify({ type: "open_relay_failed", worker: "other:2" }));
        await waitFor(() => sent.some((m) => m.type === "relay_failed"), 1000);
        assert.deepEqual(
            sent.find((m) => m.type === "relay_failed"),
            {
                type: "relay_failed",
                target: "other:2",
                edgeId: edge.id,
            }
        );
        lifeline.ws.close();
    } finally {
        setWardenClusterIpcSender(null);
        await h.close();
    }
});

test("lifeline: deleting an Edge closes its lifeline on the worker that holds it", async () => {
    clearHooks();
    const h = await startTestHub();
    const sent: any[] = [];
    try {
        const edge = await createEdge(h.baseUrl);
        const remote = `${h.hub.bootId}:2`;
        await kv.set(`edge:${edge.id}:worker`, remote, 60);
        setWardenClusterIpcSender((msg) => sent.push(msg));

        const res = await jsonFetch(`${h.baseUrl}/edges/${edge.id}`, { method: "DELETE" });
        assert.equal(res.status, 204);
        assert.deepEqual(
            sent.find((m) => m.type === "close_lifeline"),
            { type: "close_lifeline", target: remote, edgeId: edge.id, reason: "edge_deleted" }
        );
        assert.equal(await kv.get(`edge:${edge.id}:worker`), null);
    } finally {
        setWardenClusterIpcSender(null);
        await h.close();
    }
});

test("lifeline: presence TTL follows HEARTBEAT_TIMEOUT", async () => {
    clearHooks();
    const h = await startTestHub(["--heartbeat-timeout", "7"]);
    const spy = new SpyKV(initKV(parseConfig([])));
    setKV(spy);
    try {
        const edge = await createEdge(h.baseUrl);
        const lifeline = await connectRawLifeline(h.port, edge.token);
        await waitFor(() => spy.sets.some((s) => s.key === `edge:${edge.id}:worker`));
        assert.equal(spy.sets.find((s) => s.key === `edge:${edge.id}:worker`)!.ttl, 14);
        lifeline.ws.close();
    } finally {
        await h.close();
    }
});

test("lifeline: a relay session the Edge cannot dial fails the waiting stream with relay_dial_failed", async () => {
    clearHooks();
    const h = await startTestHub();
    try {
        const ends: string[] = [];
        registerHook("tunnel_end", (_req, _t, reason) => {
            ends.push(reason);
        });
        const edge = await createEdge(h.baseUrl);
        const lifeline = await connectRawLifeline(h.port, edge.token);
        // an Edge whose relay dials all fail
        const answer = (data: Buffer) => {
            const order = JSON.parse(data.toString("utf-8"));
            if (order.type !== "open_relay") return;
            lifeline.ws.send(JSON.stringify({ type: "open_relay_failed", worker: order.worker }));
        };
        lifeline.orders.forEach((o) => answer(Buffer.from(JSON.stringify(o))));
        lifeline.ws.on("message", answer);
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 9,
            edgeId: edge.id,
        });

        const runtime = tunnelClient(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        assert.deepEqual(await waitForClose(runtime), { code: 1014, reason: "relay_dial_failed" });
        await sleep(100);
        assert.deepEqual(ends, ["relay_dial_failed"]);
        lifeline.ws.close();
    } finally {
        clearHooks();
        await h.close();
    }
});

test("lifeline: a dead Edge is cut off promptly and lifeline_disconnect reports heartbeat_timeout", async () => {
    clearHooks();
    const h = await startTestHub(["--heartbeat-interval", "0.2", "--heartbeat-timeout", "0.6"]);
    try {
        const edge = await createEdge(h.baseUrl);
        const reasons: string[] = [];
        registerHook("lifeline_disconnect", (_req, disconnected, reason) => {
            if (disconnected.id === edge.id) reasons.push(reason);
        });
        const lifeline = await connectRawLifeline(h.port, edge.token, { autoPong: false });
        // Simulate a dead peer: stop reading so neither pings nor the close frame are answered.
        (lifeline.ws as any)._socket.pause();

        const start = Date.now();
        await waitFor(() => reasons.length > 0, 4000);
        assert.deepEqual(reasons, ["heartbeat_timeout"]);
        assert.ok(Date.now() - start < 4000);
        lifeline.ws.terminate();
    } finally {
        clearHooks();
        await h.close();
    }
});

test("lifeline: a KV failure while accepting closes the lifeline with 1011, the Hub keeps going", async () => {
    clearHooks();
    const h = await startTestHub();
    const spy = new SpyKV(initKV(parseConfig([])));
    try {
        const edge = await createEdge(h.baseUrl);
        setKV(spy);
        spy.failKey = (key) => key === `edge:${edge.id}:worker`;
        const failed = await connectRawLifeline(h.port, edge.token);
        assert.deepEqual(await waitForClose(failed.ws), { code: 1011, reason: "stream_error" });
        assert.equal(getLocalLifeline(edge.id), undefined);

        // KV back: the Edge's next dial holds
        spy.failKey = () => false;
        const lifeline = await connectRawLifeline(h.port, edge.token);
        await waitFor(() => Boolean(getLocalLifeline(edge.id)));
        lifeline.ws.close();
    } finally {
        await h.close();
    }
});

test("lifeline: a WebSocket message over 64 KiB closes the connection with 1009", async () => {
    clearHooks();
    const h = await startTestHub();
    try {
        const edge = await createEdge(h.baseUrl);
        const lifeline = await connectRawLifeline(h.port, edge.token);
        const closed = waitForClose(lifeline.ws);
        lifeline.ws.send(Buffer.alloc(MAX_WS_PAYLOAD + 1));
        assert.equal((await closed).code, 1009);
    } finally {
        await h.close();
    }
});
