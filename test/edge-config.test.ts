import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startEdge, type EdgeInstance } from "../src/edge/index.ts";
import { orderFromIpc, orderToIpc } from "../src/edge/cluster.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import {
    createEdge,
    createTunnel,
    jsonFetch,
    sleep,
    startTestHub,
    waitFor,
    waitForClose,
} from "./helpers.ts";

test("edge-config: the Edge applies its own HOOK_TIMEOUT", async () => {
    clearHooks();
    const h = await startTestHub(); // Hub keeps the default 5s hook timeout
    let edge: EdgeInstance | null = null;
    try {
        const edgeEntity = await createEdge(h.baseUrl);
        edge = await startEdge(
            parseConfig([
                "--hub-url",
                `ws://127.0.0.1:${h.port}`,
                "--token",
                edgeEntity.token,
                "--hook-timeout",
                "0.2",
            ])
        );
        await waitFor(async () => {
            const res = await jsonFetch(`${h.baseUrl}/edges/${edgeEntity.id}`);
            return res.data?.connected === true;
        });
        registerHook("edge_tunnel_request", () => sleep(1000));
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 9,
            edgeId: edgeEntity.id,
        });
        const ws = new WebSocket(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        assert.deepEqual(await waitForClose(ws), { code: 1011, reason: "hook_error" });
    } finally {
        clearHooks();
        if (edge) await edge.stop();
        await h.close();
    }
});

test("edge-config: Primary-to-worker orders carry an absolute deadline", () => {
    const order = {
        type: "connect_tunnel" as const,
        reqId: "r",
        ticket: "tmp_x",
        tunnel: { id: "t", name: "n", internalHost: "h", internalPort: 1, metadata: {} },
        client: { ip: "1.2.3.4" },
        connectTimeoutMs: 5000,
    };
    const msg = orderToIpc(order, 1_000_000);
    assert.equal(msg.deadline, 1_005_000);
    assert.equal("connectTimeoutMs" in msg, false);

    const back = orderFromIpc(msg, 1_002_000);
    assert.equal(back.connectTimeoutMs, 3000);
    assert.equal(back.ticket, "tmp_x");
    assert.equal(orderFromIpc(msg, 1_010_000).connectTimeoutMs, 0);
});
