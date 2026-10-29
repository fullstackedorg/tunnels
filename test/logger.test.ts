import test from "node:test";
import assert from "node:assert/strict";
import { logger } from "../src/utils/logger.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";

test("logger: ring buffer stores entries and respects MAX_BREADCRUMBS limit", () => {
    logger.clearBreadcrumbs();
    for (let i = 0; i < 120; i++) {
        logger.debug("Test", `Message ${i}`);
    }

    const crumbs = logger.getBreadcrumbs();
    assert.equal(crumbs.length, 100);
    assert.equal(crumbs[0].message, "Message 20");
    assert.equal(crumbs[99].message, "Message 119");
});

test("logger: worker identity is recorded in entries", () => {
    logger.clearBreadcrumbs();
    logger.setWorkerIdentity("test-boot:42");
    logger.info("Test", "Identity check");

    const crumbs = logger.getBreadcrumbs();
    assert.equal(crumbs[crumbs.length - 1].worker, "test-boot:42");
});

test("logger: error objects in meta are serialized cleanly", () => {
    logger.clearBreadcrumbs();
    const err = new Error("Sample failure");
    logger.error("Test", "Failure occurred", { error: err });

    const crumbs = logger.getBreadcrumbs();
    const last = crumbs[crumbs.length - 1];
    assert.equal(last.meta?.error?.message, "Sample failure");
    assert.ok(last.meta?.error?.stack);
});

test("logger: dispatches to log hook with re-entrancy prevention", () => {
    clearHooks();
    const received: string[] = [];

    registerHook("log", (_req, entry) => {
        received.push(entry.message);
        // Attempt re-entrant logging inside the hook
        logger.info("InsideHook", "Nested log");
    });

    logger.info("Outside", "First message");
    assert.ok(received.includes("First message"));
    // The nested log should NOT have been re-dispatched to the log hook
    assert.equal(received.filter((m) => m === "Nested log").length, 0);

    clearHooks();
});
