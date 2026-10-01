import test from "node:test";
import assert from "node:assert/strict";
import { startHub } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { clearHooks } from "../src/utils/hooks.ts";
import { decorateRequest } from "../src/http/deny.ts";
import { getAvailablePort, createTempDir, cleanupTempDir, jsonFetch } from "./helpers.ts";

test("api-roll-and-helpers: roll-token endpoint for edge and tunnel", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("api-roll-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. Create edge
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Roll Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;
        const oldEdgeToken = edgeRes.data.token;

        // Roll edge token
        const rolledEdge = await jsonFetch(`${baseUrl}/edges/${edgeId}/roll-token`, {
            method: "POST",
        });
        assert.equal(rolledEdge.status, 200);
        assert.notEqual(rolledEdge.data.token, oldEdgeToken);
        assert.ok(rolledEdge.data.token.startsWith("edg_"));

        // 2. Create tunnel
        const tunRes = await jsonFetch(`${baseUrl}/tunnels`, {
            method: "POST",
            body: {
                name: "Roll Tunnel",
                internalHost: "127.0.0.1",
                internalPort: 8080,
            },
        });
        assert.equal(tunRes.status, 201);
        const tunnelId = tunRes.data.id;
        const oldTunToken = tunRes.data.token;

        // Roll tunnel token
        const rolledTun = await jsonFetch(`${baseUrl}/tunnels/${tunnelId}/roll-token`, {
            method: "POST",
        });
        assert.equal(rolledTun.status, 200);
        assert.notEqual(rolledTun.data.token, oldTunToken);
        assert.ok(rolledTun.data.token.startsWith("tun_"));

        // 3. Invalid UUID returns 400
        const badIdEdge = await jsonFetch(`${baseUrl}/edges/not-a-uuid/roll-token`, {
            method: "POST",
        });
        assert.equal(badIdEdge.status, 400);

        const badIdTun = await jsonFetch(`${baseUrl}/tunnels/not-a-uuid/roll-token`, {
            method: "POST",
        });
        assert.equal(badIdTun.status, 400);
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-roll-and-helpers: query param errors and malformed JSON payloads return 400", async () => {
    clearHooks();
    const port = await getAvailablePort();
    const tempDir = createTempDir("api-helpers-");
    const config = parseConfig(["--port", String(port), "--data-dir", tempDir]);
    const hub = await startHub(config);

    try {
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. Invalid internalPort filter value
        const queryRes = await jsonFetch(`${baseUrl}/tunnels?internalPort=notanumber`);
        assert.equal(queryRes.status, 400);
        assert.equal(queryRes.data.error, "Invalid internalPort filter value");

        // 2. Malformed JSON body
        const badJsonRes = await fetch(`${baseUrl}/tunnels`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{malformed_json",
        });
        assert.equal(badJsonRes.status, 400);
        const errData = await badJsonRes.json();
        assert.equal(errData.error, "Malformed JSON");
    } finally {
        await hub.close();
        cleanupTempDir(tempDir);
    }
});

test("api-roll-and-helpers: deny() with options sets headers and fields", () => {
    const fakeSocket: any = {
        destroyed: false,
        written: "",
        write(data: string) {
            this.written += data;
        },
        end() {
            this.destroyed = true;
        },
        destroy() {
            this.destroyed = true;
        },
    };

    const fakeReq: any = {
        headers: { "x-request-id": "req-123" },
        socket: fakeSocket,
    };

    const decorated = decorateRequest(fakeReq, fakeSocket, []);
    assert.equal(decorated.correlationId, "req-123");

    // Call deny with options object containing headers and fields
    decorated.deny(422, "Unprocessable Entity", {
        headers: { "X-RateLimit": "100" },
        fields: { name: "Name is required" },
    });

    assert.equal(decorated.denied, true);
    assert.equal(decorated.denyReason, "Unprocessable Entity");
    assert.ok(fakeSocket.written.includes("HTTP/1.1 422"));
    assert.ok(fakeSocket.written.includes("X-RateLimit: 100"));
    assert.ok(fakeSocket.written.includes("Name is required"));
});
