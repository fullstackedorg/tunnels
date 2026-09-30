import test from "node:test";
import assert from "node:assert/strict";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { kv } from "../src/kv/index.ts";
import { createTicket, claimTicket, cancelTicketTombstone } from "../src/warden/tickets.ts";
import {
    setSaturationLimits,
    isLifelineSaturated,
    recordPendingOrder,
    deletePendingOrder,
} from "../src/warden/orders.ts";
import {
    getAvailablePort,
    createTempDir,
    cleanupTempDir,
    connectTestWs,
    jsonFetch,
} from "./helpers.ts";

test("warden: tickets atomic creation, claim (getdel), and cancellation tombstones", async () => {
    const ticket = await createTicket("worker-1", "worker-2", "edge-1", "req-1", "tunnel-1", 10);
    assert.ok(ticket.startsWith("tmp_"));

    // First claim should succeed (atomic getdel)
    const claimed1 = await claimTicket(ticket);
    assert.ok(claimed1);
    assert.equal((claimed1 as any).originWorker, "worker-1");
    assert.equal((claimed1 as any).lifelineWorker, "worker-2");
    assert.equal((claimed1 as any).edgeId, "edge-1");

    // Second claim should return null
    const claimed2 = await claimTicket(ticket);
    assert.equal(claimed2, null);

    // Cancel tombstone creates status: "cancelled"
    const cancelTicket = await createTicket(
        "worker-1",
        "worker-2",
        "edge-1",
        "req-2",
        "tunnel-1",
        10
    );
    await cancelTicketTombstone(cancelTicket, "connect_timeout");
    const claimedCancel = await claimTicket(cancelTicket);
    assert.ok(claimedCancel);
    assert.equal((claimedCancel as any).status, "cancelled");
    assert.equal((claimedCancel as any).reason, "connect_timeout");
});

test("warden: lifeline saturation limits check pending orders count and buffer", () => {
    setSaturationLimits(2, 1024);

    const fakeWs: any = { bufferedAmount: 0 };
    assert.equal(isLifelineSaturated("edge-sat-1", fakeWs), false);

    recordPendingOrder("t1", {
        originWorker: "1:1",
        reqId: "r1",
        edgeId: "edge-sat-1",
        expiresAt: Date.now() + 5000,
    });
    assert.equal(isLifelineSaturated("edge-sat-1", fakeWs), false);

    recordPendingOrder("t2", {
        originWorker: "1:1",
        reqId: "r2",
        edgeId: "edge-sat-1",
        expiresAt: Date.now() + 5000,
    });
    // Now count is 2 (equal to limit)
    assert.equal(isLifelineSaturated("edge-sat-1", fakeWs), true);

    deletePendingOrder("t1");
    deletePendingOrder("t2");
    assert.equal(isLifelineSaturated("edge-sat-1", fakeWs), false);

    // Buffer saturation
    fakeWs.bufferedAmount = 2048;
    assert.equal(isLifelineSaturated("edge-sat-1", fakeWs), true);

    // Reset default saturation limits
    setSaturationLimits(100, 64 * 1024);
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
