import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startEdge, type EdgeInstance } from "../src/edge/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import {
    connectRawLifeline,
    connectTestWs,
    createEdge,
    createTestEchoServer,
    createTunnel,
    jsonFetch,
    sleep,
    startTestHub,
    waitFor,
    waitForClose,
} from "./helpers.ts";

// 192.0.2.0/24 (TEST-NET-1) drops packets, so a dial to it stays pending until a timer fires.
const BLACKHOLE = "192.0.2.1";

function recordTunnelEnds(): string[] {
    const ends: string[] = [];
    registerHook("tunnel_end", (_req, _tunnel, reason) => {
        ends.push(reason);
    });
    return ends;
}

test("session-lifecycle: severing an established session fires tunnel_end exactly once", async () => {
    clearHooks();
    const echo = await createTestEchoServer();
    const h = await startTestHub();
    try {
        const ends = recordTunnelEnds();
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: echo.port,
        });
        const ws = await connectTestWs(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        const echoed = new Promise((r) => ws.once("message", r));
        ws.send(Buffer.from("ping"));
        await echoed;

        const closed = waitForClose(ws);
        await jsonFetch(`${h.baseUrl}/tunnels/${tunnel.id}/roll-token`, { method: "POST" });
        assert.deepEqual(await closed, { code: 1000, reason: "token_rolled" });

        await sleep(300);
        assert.deepEqual(ends, ["token_rolled"]);
    } finally {
        await h.close();
        await echo.close();
        clearHooks();
    }
});

test("session-lifecycle: severing a session before its target is ready fires tunnel_end once", async () => {
    clearHooks();
    const h = await startTestHub(["--connect-timeout", "1"]);
    try {
        const ends = recordTunnelEnds();
        let started = false;
        registerHook("tunnel_start", () => {
            started = true;
        });
        const tunnel = await createTunnel(h.baseUrl, { internalHost: BLACKHOLE, internalPort: 9 });
        const ws = await connectTestWs(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        await waitFor(() => started);

        const closed = waitForClose(ws);
        await jsonFetch(`${h.baseUrl}/tunnels/${tunnel.id}/roll-token`, { method: "POST" });
        assert.deepEqual(await closed, { code: 1000, reason: "token_rolled" });

        // Outlive the connect timer: the abandoned dial must not report a second ending.
        await sleep(1500);
        assert.deepEqual(ends, ["token_rolled"]);
    } finally {
        await h.close();
        clearHooks();
    }
});

test("session-lifecycle: runtime disconnecting during a direct dial ends with client_aborted", async () => {
    clearHooks();
    const h = await startTestHub(["--connect-timeout", "2"]);
    try {
        const ends = recordTunnelEnds();
        let started = false;
        registerHook("tunnel_start", () => {
            started = true;
        });
        const tunnel = await createTunnel(h.baseUrl, { internalHost: BLACKHOLE, internalPort: 9 });
        const ws = await connectTestWs(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        await waitFor(() => started);

        ws.close(1000, "client_close");
        await waitFor(() => ends.length > 0, 1000);
        assert.deepEqual(ends, ["client_aborted"]);

        await sleep(2200);
        assert.deepEqual(ends, ["client_aborted"]);
    } finally {
        await h.close();
        clearHooks();
    }
});

test("session-lifecycle: a runtime close reason outside the taxonomy is reported as client_close", async () => {
    clearHooks();
    const echo = await createTestEchoServer();
    const h = await startTestHub();
    try {
        const ends = recordTunnelEnds();
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: echo.port,
        });
        const ws = await connectTestWs(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        const echoed = new Promise((r) => ws.once("message", r));
        ws.send(Buffer.from("ping"));
        await echoed;

        ws.close(1000, "bye now");
        await waitFor(() => ends.length > 0);
        await sleep(200);
        assert.deepEqual(ends, ["client_close"]);
    } finally {
        await h.close();
        await echo.close();
        clearHooks();
    }
});

test("session-lifecycle: target failure after handoff propagates the Edge's close reason to the runtime", async () => {
    clearHooks();
    const h = await startTestHub(["--connect-timeout", "1"]);
    let edge: EdgeInstance | null = null;
    try {
        const ends = recordTunnelEnds();
        const edgeEntity = await createEdge(h.baseUrl);
        edge = await startEdge(
            parseConfig(["--hub-url", `ws://127.0.0.1:${h.port}`, "--token", edgeEntity.token])
        );
        await waitFor(async () => {
            const res = await jsonFetch(`${h.baseUrl}/edges/${edgeEntity.id}`);
            return res.data?.connected === true;
        });
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: BLACKHOLE,
            internalPort: 9,
            edgeId: edgeEntity.id,
        });

        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        assert.deepEqual(await waitForClose(ws), { code: 1014, reason: "connect_timeout" });
        await sleep(200);
        assert.deepEqual(ends, ["connect_timeout"]);
    } finally {
        if (edge) await edge.stop();
        await h.close();
        clearHooks();
    }
});

test("session-lifecycle: hub shutdown cancels pending relayed setups on the Edge", async () => {
    clearHooks();
    const h = await startTestHub();
    try {
        const ends = recordTunnelEnds();
        const edgeEntity = await createEdge(h.baseUrl);
        const lifeline = await connectRawLifeline(h.port, edgeEntity.token);
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 9,
            edgeId: edgeEntity.id,
        });

        const ws = await connectTestWs(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        await waitFor(() => lifeline.orders.some((o) => o.type === "connect_tunnel"));
        const ticket = lifeline.orders[0].ticket;

        const runtimeClosed = waitForClose(ws);
        const lifelineClosed = waitForClose(lifeline.ws);
        await h.close();

        assert.deepEqual(await runtimeClosed, { code: 1001, reason: "hub_shutdown" });
        assert.deepEqual(await lifelineClosed, { code: 1001, reason: "hub_shutdown" });
        const cancel = lifeline.orders.find((o) => o.type === "cancel_tunnel");
        assert.ok(cancel, "Edge should receive cancel_tunnel before the lifeline closes");
        assert.equal(cancel.ticket, ticket);
        assert.equal(cancel.reason, "hub_shutdown");
        assert.deepEqual(ends, ["hub_shutdown"]);
    } finally {
        await h.close();
        clearHooks();
    }
});
