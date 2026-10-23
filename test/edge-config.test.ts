import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startEdge, type EdgeInstance } from "../src/edge/index.ts";
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
import { tunnelClient } from "./mux-client.ts";

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
        const ws = tunnelClient(`ws://127.0.0.1:${h.port}/`, {
            headers: { Authorization: tunnel.token },
        });
        assert.deepEqual(await waitForClose(ws), { code: 1011, reason: "hook_error" });
    } finally {
        clearHooks();
        if (edge) await edge.stop();
        await h.close();
    }
});
