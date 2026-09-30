import test from "node:test";
import assert from "node:assert/strict";
import {
    registerHook,
    clearHooks,
    runGatingHook,
    runPostQueryHook,
    runAwaitedHook,
    dispatchTelemetry,
    setHookTimeout,
} from "../src/utils/hooks.ts";

test("hooks: registering unknown hook throws descriptive error", () => {
    assert.throws(
        () => {
            registerHook("non_existent_hook", () => {});
        },
        {
            message: /Unknown hook name: "non_existent_hook"/,
        }
    );
});

test("hooks: unsubscribe removes handler cleanly", async () => {
    clearHooks();
    let called = 0;
    const unsub = registerHook("hub_request", () => {
        called++;
    });

    await runGatingHook("hub_request", { denied: false });
    assert.equal(called, 1);

    unsub();
    await runGatingHook("hub_request", { denied: false });
    assert.equal(called, 1);
});

test("hooks: gating hook short-circuits immediately when req.denied is set", async () => {
    clearHooks();
    const calls: string[] = [];

    registerHook("hub_request", (req) => {
        calls.push("first");
        req.denied = true;
    });

    registerHook("hub_request", () => {
        calls.push("second");
    });

    const context = { denied: false };
    const passed = await runGatingHook("hub_request", context);
    assert.equal(passed, false);
    assert.deepEqual(calls, ["first"]);
});

test("hooks: gating hook is fail-closed on throw", async () => {
    clearHooks();
    let deniedCalled = false;

    registerHook("hub_request", () => {
        throw new Error("Gating failure");
    });

    const context: any = {
        denied: false,
        deny: (status: number, reason: string) => {
            deniedCalled = true;
            context.denied = true;
        },
    };

    const passed = await runGatingHook("hub_request", context);
    assert.equal(passed, false);
    assert.equal(deniedCalled, true);
    assert.equal(context.denied, true);
});

test("hooks: gating hook times out fail-closed", async () => {
    clearHooks();
    setHookTimeout(0.05); // 50ms

    registerHook("hub_request", async () => {
        await new Promise((r) => setTimeout(r, 150));
    });

    const context: any = {
        denied: false,
        deny: () => {
            context.denied = true;
        },
    };

    const passed = await runGatingHook("hub_request", context);
    assert.equal(passed, false);
    assert.equal(context.denied, true);

    setHookTimeout(5);
});

test("hooks: post-mutation hooks are fail-open", async () => {
    clearHooks();
    registerHook("create_tunnel_done", () => {
        throw new Error("Failed post-mutation task");
    });

    // Should not throw
    await runAwaitedHook("create_tunnel_done", {}, {});
});

test("hooks: telemetry hooks are non-blocking and fail-open", async () => {
    clearHooks();
    registerHook("tunnel_end", () => {
        throw new Error("Telemetry failure");
    });

    // Should not throw synchronously or asynchronously
    dispatchTelemetry("tunnel_end", {}, {}, "client_close");
});
