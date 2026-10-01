import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { initKV, setKV, kv } from "../src/kv/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { logger } from "../src/utils/logger.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import { handleWardenIpc, setWardenClusterIpcSender } from "../src/warden/index.ts";
import { getLocalLifeline } from "../src/warden/lifeline.ts";
import { recordPendingOrder } from "../src/warden/orders.ts";
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

        // Orders still reach the replacement lifeline.
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 9,
            edgeId: edge.id,
        });
        const runtime = await connectTestWs(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        await waitFor(() => second.orders.some((o) => o.type === "connect_tunnel"));
        runtime.terminate();
        second.ws.close();
    } finally {
        await h.close();
    }
});

test("lifeline: relayed_tunnel_cancel from another worker sends cancel_tunnel on the lifeline", async () => {
    clearHooks();
    const h = await startTestHub();
    try {
        const edge = await createEdge(h.baseUrl);
        const lifeline = await connectRawLifeline(h.port, edge.token);
        await waitFor(() => Boolean(getLocalLifeline(edge.id)));

        recordPendingOrder("tmp_remote", {
            originWorker: "other:2",
            reqId: "req-1",
            edgeId: edge.id,
            expiresAt: Date.now() + 10_000,
        });
        handleWardenIpc({
            type: "relayed_tunnel_cancel",
            target: logger.getWorkerIdentity(),
            ticket: "tmp_remote",
            reason: "client_aborted",
        });

        await waitFor(() => lifeline.orders.some((o) => o.type === "cancel_tunnel"), 1000);
        const cancel = lifeline.orders.find((o) => o.type === "cancel_tunnel");
        assert.deepEqual(cancel, {
            type: "cancel_tunnel",
            reqId: "req-1",
            ticket: "tmp_remote",
            reason: "client_aborted",
        });
        lifeline.ws.close();
    } finally {
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

test("lifeline: ticket and presence TTLs follow CONNECT_TIMEOUT and HEARTBEAT_TIMEOUT", async () => {
    clearHooks();
    const h = await startTestHub(["--connect-timeout", "3", "--heartbeat-timeout", "7"]);
    const spy = new SpyKV(initKV(parseConfig([])));
    setKV(spy);
    try {
        const edge = await createEdge(h.baseUrl);
        const lifeline = await connectRawLifeline(h.port, edge.token);
        await waitFor(() => spy.sets.some((s) => s.key === `edge:${edge.id}:worker`));
        assert.equal(spy.sets.find((s) => s.key === `edge:${edge.id}:worker`)!.ttl, 14);

        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 9,
            edgeId: edge.id,
        });
        const runtime = await connectTestWs(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        await waitFor(() => lifeline.orders.some((o) => o.type === "connect_tunnel"));
        const ticketSet = spy.sets.find((s) => s.key.startsWith("relayed_request:"));
        assert.equal(ticketSet!.ttl, 5);
        assert.ok(lifeline.orders[0].connectTimeoutMs <= 3000);

        runtime.terminate();
        lifeline.ws.close();
    } finally {
        await h.close();
    }
});

test("lifeline: KV unavailable during relayed setup closes the runtime with 1011 stream_error", async () => {
    clearHooks();
    const h = await startTestHub();
    const spy = new SpyKV(initKV(parseConfig([])));
    setKV(spy);
    try {
        const ends: string[] = [];
        registerHook("tunnel_end", (_req, _t, reason) => {
            ends.push(reason);
        });
        const edge = await createEdge(h.baseUrl);
        const lifeline = await connectRawLifeline(h.port, edge.token);
        await waitFor(() => Boolean(getLocalLifeline(edge.id)));
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 9,
            edgeId: edge.id,
        });

        spy.failKey = (key) => key.startsWith("edge:") || key.startsWith("relayed_request:");
        const runtime = new WebSocket(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        assert.deepEqual(await waitForClose(runtime), { code: 1011, reason: "stream_error" });
        await sleep(100);
        assert.deepEqual(ends, ["stream_error"]);
        spy.failKey = () => false;
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
