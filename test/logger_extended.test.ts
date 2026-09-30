import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../src/utils/logger.ts";
import { loadPlugins, clearHooks } from "../src/utils/hooks.ts";
import { createTempDir, cleanupTempDir } from "./helpers.ts";

test("logger_extended: json log format outputs valid JSON", () => {
    logger.setLogFormat("json");
    logger.setLogLevel("info");

    const originalStderr = process.stderr.write;
    let written = "";

    process.stderr.write = ((chunk: any) => {
        written += chunk.toString();
        return true;
    }) as any;

    try {
        logger.warn("TestCat", "Warning JSON message", { customKey: 123 });
        assert.ok(written.length > 0);
        const parsed = JSON.parse(written.trim().split("\n").pop()!);
        assert.equal(parsed.level, "warn");
        assert.equal(parsed.category, "TestCat");
        assert.equal(parsed.message, "Warning JSON message");
        assert.equal(parsed.meta.customKey, 123);
    } finally {
        process.stderr.write = originalStderr;
        logger.setLogFormat("text");
    }
});

test("logger_extended: suppressed log levels are kept in breadcrumbs but not written", () => {
    logger.setLogLevel("error");
    logger.clearBreadcrumbs();

    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    let stdoutWritten = "";
    let stderrWritten = "";

    process.stdout.write = ((chunk: any) => {
        stdoutWritten += chunk.toString();
        return true;
    }) as any;

    process.stderr.write = ((chunk: any) => {
        stderrWritten += chunk.toString();
        return true;
    }) as any;

    try {
        logger.debug("DebugCat", "Suppressed debug");
        logger.info("InfoCat", "Suppressed info");
        logger.warn("WarnCat", "Suppressed warn");

        // Nothing written
        assert.equal(stdoutWritten, "");
        assert.equal(stderrWritten, "");

        // But kept in breadcrumbs
        const breadcrumbs = logger.getBreadcrumbs();
        assert.equal(breadcrumbs.length, 3);
        assert.equal(breadcrumbs[0].message, "Suppressed debug");
        assert.equal(breadcrumbs[1].message, "Suppressed info");
        assert.equal(breadcrumbs[2].message, "Suppressed warn");
    } finally {
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
        logger.setLogLevel("info");
        logger.clearBreadcrumbs();
    }
});

test("logger_extended: logger.error dumps breadcrumbs to stderr", () => {
    logger.setLogLevel("info");
    logger.clearBreadcrumbs();

    const originalStderr = process.stderr.write;
    let stderrWritten = "";

    process.stderr.write = ((chunk: any) => {
        stderrWritten += chunk.toString();
        return true;
    }) as any;

    try {
        logger.info("Step1", "Step 1 complete");
        logger.info("Step2", "Step 2 complete");
        logger.error("Step3", "Step 3 crashed", { error: new Error("Test crash") });

        assert.ok(stderrWritten.includes("--- Begin Breadcrumbs (3 entries) ---"));
        assert.ok(stderrWritten.includes("Step 1 complete"));
        assert.ok(stderrWritten.includes("Step 2 complete"));
        assert.ok(stderrWritten.includes("--- End Breadcrumbs ---"));
    } finally {
        process.stderr.write = originalStderr;
        logger.clearBreadcrumbs();
    }
});

test("logger_extended: loadPlugins dynamically imports plugins and throws on missing plugin", async () => {
    clearHooks();
    const dir = createTempDir("plugins-");
    const pluginPath = path.join(dir, "my-plugin.mjs");

    // Write a dummy ESM plugin
    fs.writeFileSync(
        pluginPath,
        `import { registerHook } from '${path.resolve("src/utils/hooks.ts")}';\n` +
            `registerHook('tunnel_start', () => {});\n`,
        "utf-8"
    );

    try {
        await loadPlugins([pluginPath]);
        assert.ok(true, "Plugin loaded successfully");

        // Missing plugin throws
        await assert.rejects(async () => {
            await loadPlugins([path.join(dir, "non-existent-plugin.mjs")]);
        });
    } finally {
        clearHooks();
        cleanupTempDir(dir);
    }
});
