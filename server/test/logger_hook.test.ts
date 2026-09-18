import test from "node:test";
import assert from "node:assert";
import { logger, type Breadcrumb } from "../src/utils/logger.ts";
import { registerHook } from "../src/utils/hooks.ts";

test("Logger triggers 'log' hook for info, warn, and error", () => {
    const capturedLogs: Breadcrumb[] = [];
    const unregister = registerHook("log", (_, entry: Breadcrumb) => {
        capturedLogs.push(entry);
    });

    try {
        const uniqueId = Date.now().toString();
        logger.info("TestCategory", `Test info message ${uniqueId}`, { extra: 1 });
        logger.warn("TestCategory", `Test warn message ${uniqueId}`);
        logger.error("TestCategory", `Test error message ${uniqueId}`);

        const infoLog = capturedLogs.find((l) => l.message === `Test info message ${uniqueId}`);
        const warnLog = capturedLogs.find((l) => l.message === `Test warn message ${uniqueId}`);
        const errorLog = capturedLogs.find((l) => l.message === `Test error message ${uniqueId}`);

        assert.ok(infoLog, "info log should be captured by log hook");
        assert.strictEqual(infoLog.level, "info");
        assert.strictEqual(infoLog.category, "TestCategory");
        assert.strictEqual(infoLog.metadata?.extra, 1);

        assert.ok(warnLog, "warn log should be captured by log hook");
        assert.strictEqual(warnLog.level, "warn");

        assert.ok(errorLog, "error log should be captured by log hook");
        assert.strictEqual(errorLog.level, "error");
    } finally {
        unregister();
    }
});
