import test from "node:test";
import assert from "node:assert";
import * as ws from "ws";
import { registerHook } from "../src/utils/hooks";
import { setupTestServer } from "./helpers";

const PORT = 3459;
await setupTestServer(PORT);

test("Hooks - stop execution using hooks (on-request, rest_api_access & on-upgrade)", async () => {
    // 1. Register an "on-request" hook that stops execution when requesting /blocked-by-hook
    registerHook("on_request", async (req) => {
        if (req.url === "/blocked-by-hook") {
            req.destroy();
        }
    });

    // 2. Register a "rest_api_access" hook that stops execution when header x-block-api is present
    registerHook("rest_api_access", async (req) => {
        if (req.headers["x-block-api"] === "true") {
            req.destroy();
        }
    });

    // 3. Register an "on-upgrade" hook that stops execution when header x-block-ws is present
    registerHook("on_upgrade", async (req) => {
        if (req.headers["x-block-ws"] === "true") {
            req.destroy();
        }
    });

    // Request to /blocked-by-hook should be destroyed/stopped on-request
    await assert.rejects(
        fetch(`http://127.0.0.1:${PORT}/blocked-by-hook`),
        "Request blocked by on-request hook should fail",
    );

    // Request with x-block-api header should be destroyed/stopped during rest_api_access
    await assert.rejects(
        fetch(`http://127.0.0.1:${PORT}/services`, {
            headers: { "x-block-api": "true" },
        }),
        "Request blocked by rest_api_access hook should fail",
    );

    // Normal requests without blocking conditions should proceed normally
    const allowedRes = await fetch(`http://127.0.0.1:${PORT}/services`);
    assert.strictEqual(
        allowedRes.status,
        200,
        "Unblocked REST API request should succeed",
    );

    // Register a test service for WebSocket upgrade testing
    const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-hook-blocked-ws-service",
            internalHost: "127.0.0.1",
            internalPort: 12345,
            workerCount: 1,
        }),
    });
    const service = await serviceRes.json();

    // WebSocket upgrade request with x-block-ws header should be destroyed/stopped on-upgrade
    const blockedWsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: {
            Authorization: service.token,
            "x-block-ws": "true",
        },
    });

    await assert.rejects(
        new Promise<void>((resolve, reject) => {
            blockedWsClient.on("open", resolve);
            blockedWsClient.on("error", reject);
        }),
        "WebSocket request blocked by on-upgrade hook should fail",
    );
});
