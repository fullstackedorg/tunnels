import test from "node:test";
import assert from "node:assert";
import * as ws from "ws";
import { registerHook, executeHook } from "../src/utils/hooks.ts";
import { setupTestServer } from "./helpers.ts";

const PORT = 3459;
await setupTestServer(PORT);

test("Hooks - stop execution using hooks (on-request, rest_api_access & on-upgrade)", async (t) => {
    let blockedWsClient: ws.WebSocket | null = null;
    let unregisterOnRequest: (() => void) | null = null;
    let unregisterRestApi: (() => void) | null = null;
    let unregisterOnUpgrade: (() => void) | null = null;

    t.after(() => {
        unregisterOnRequest?.();
        unregisterRestApi?.();
        unregisterOnUpgrade?.();
        blockedWsClient?.close();
    });

    // 1. Register an "on-request" hook that stops execution when requesting /blocked-by-hook
    unregisterOnRequest = registerHook("on_request", async (req) => {
        if (req.url === "/blocked-by-hook") {
            req.deny();
        }
    });

    // 2. Register a "rest_api_access" hook that stops execution when header x-block-api is present
    unregisterRestApi = registerHook("rest_api_access", async (req) => {
        if (req.headers["x-block-api"] === "true") {
            req.deny();
        }
    });

    // 3. Register an "on-upgrade" hook that stops execution when header x-block-ws is present
    unregisterOnUpgrade = registerHook("on_upgrade", async (req) => {
        if (req.headers["x-block-ws"] === "true") {
            req.deny();
        }
    });

    // Request to /blocked-by-hook should be destroyed/stopped on-request and return 403 Denied
    const onRequestRes = await fetch(
        `http://127.0.0.1:${PORT}/blocked-by-hook`,
    );
    assert.strictEqual(
        onRequestRes.status,
        403,
        "Request blocked by on-request hook should return 403 Forbidden",
    );
    assert.strictEqual(
        await onRequestRes.text(),
        "Denied",
        "Request blocked by on-request hook should return Denied",
    );

    // Request with x-block-api header should be destroyed/stopped during rest_api_access and return 403 Denied
    const restApiRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        headers: { "x-block-api": "true" },
    });
    assert.strictEqual(
        restApiRes.status,
        403,
        "Request blocked by rest_api_access hook should return 403 Forbidden",
    );
    assert.strictEqual(
        await restApiRes.text(),
        "Denied",
        "Request blocked by rest_api_access hook should return Denied",
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
    blockedWsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: {
            Authorization: service.token,
            "x-block-ws": "true",
        },
    });

    await assert.rejects(
        new Promise<void>((resolve, reject) => {
            blockedWsClient!.on("open", resolve);
            blockedWsClient!.on("error", reject);
        }),
        "WebSocket request blocked by on-upgrade hook should fail",
    );
});

test("IncomingMessageWithDeny includes unique id and is passed to hooks", async (t) => {
    let capturedReq: any = null;
    let customReq: any = null;
    let startReq: any = null;

    const unregisterOnRequest = registerHook("on_request", (req) => {
        if (req.url === "/test-id-auto") {
            capturedReq = req;
        } else if (req.url === "/test-id-custom") {
            customReq = req;
        }
    });

    const unregisterStart = registerHook("tunnel_service_start", (req) => {
        startReq = req;
    });

    t.after(() => {
        unregisterOnRequest();
        unregisterStart();
    });

    // 1. Auto-generated UUID test
    await fetch(`http://127.0.0.1:${PORT}/test-id-auto`);
    assert.ok(capturedReq, "on_request hook should be called");
    assert.ok(capturedReq.id, "req.id should be defined");
    assert.strictEqual(typeof capturedReq.id, "string");
    assert.strictEqual(capturedReq.id.length > 10, true, "req.id should be a valid UUID");

    // 2. Custom x-request-id header test
    await fetch(`http://127.0.0.1:${PORT}/test-id-custom`, {
        headers: { "x-request-id": "custom-uuid-12345" },
    });
    assert.ok(customReq, "on_request hook should be called");
    assert.strictEqual(customReq.id, "custom-uuid-12345", "req.id should preserve x-request-id");

    // 3. Service upgrade hook test
    const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-id-service",
            internalHost: "127.0.0.1",
            internalPort: 54321,
            workerCount: 1,
        }),
    });
    const service = await serviceRes.json();

    const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: {
            Authorization: service.token,
            "x-request-id": "ws-req-id-9999",
        },
    });

    await new Promise<void>((resolve) => {
        wsClient.on("open", resolve);
        wsClient.on("error", () => resolve());
    });
    wsClient.close();

    assert.ok(startReq, "tunnel_service_start hook should be called");
    assert.strictEqual(startReq.id, "ws-req-id-9999", "tunnel_service_start should receive req with id");
    assert.strictEqual(typeof startReq.deny, "function", "req should have deny function");
});

test("executeHook catches errors internally and logs error message", async (t) => {
    let capturedLog: any = null;
    const unregisterLog = registerHook("log", (_, entry) => {
        if (entry.message?.includes("Error in hook")) {
            capturedLog = entry;
        }
    });

    const unregisterSync = registerHook("test_sync_error_hook", () => {
        throw new Error("sync failure in hook");
    });

    const unregisterAsync = registerHook("test_async_error_hook", async () => {
        throw new Error("async failure in hook");
    });

    t.after(() => {
        unregisterLog();
        unregisterSync();
        unregisterAsync();
    });

    // 1. Synchronous throw
    assert.doesNotThrow(() => {
        executeHook("test_sync_error_hook", null);
    });
    assert.ok(capturedLog, "log hook should capture error from sync hook failure");
    assert.match(
        capturedLog.message,
        /Error in hook \[test_sync_error_hook\]: sync failure in hook/,
    );

    capturedLog = null;

    // 2. Asynchronous throw / rejection
    await assert.doesNotReject(async () => {
        await executeHook("test_async_error_hook", null);
    });
    assert.ok(capturedLog, "log hook should capture error from async hook failure");
    assert.match(
        capturedLog.message,
        /Error in hook \[test_async_error_hook\]: async failure in hook/,
    );
});

