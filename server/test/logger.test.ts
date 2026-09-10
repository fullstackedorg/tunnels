import test from "node:test";
import assert from "node:assert";
import { Logger } from "../src/utils/logger.ts";

const ISO_TIMESTAMP_REGEX = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/;

test("Logger.prototype.info outputs ISO 8601 timestamp prefix", (t) => {
    const logger = new Logger();
    const originalLog = console.log;
    t.after(() => {
        console.log = originalLog;
    });

    const logs: string[] = [];
    console.log = (msg: string) => {
        logs.push(msg);
    };

    logger.info("test-category", "hello info world");

    assert.strictEqual(logs.length, 1);
    const logLine = logs[0];
    assert.match(
        logLine,
        ISO_TIMESTAMP_REGEX,
        "Log line must start with ISO 8601 timestamp",
    );
    assert.match(
        logLine,
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[test-category\] hello info world$/,
        "Log line must match timestamp category and message format",
    );

    // Verify the extracted timestamp is valid
    const match = logLine.match(/^\[([^\]]+)\]/);
    assert.ok(match, "Timestamp prefix must be bracketed");
    const parsedDate = new Date(match[1]);
    assert.strictEqual(
        parsedDate.toISOString(),
        match[1],
        "Extracted timestamp must be a valid ISO string",
    );
});

test("Logger.prototype.warn outputs ISO 8601 timestamp prefix", (t) => {
    const logger = new Logger();
    const originalWarn = console.warn;
    t.after(() => {
        console.warn = originalWarn;
    });

    const warns: string[] = [];
    console.warn = (msg: string) => {
        warns.push(msg);
    };

    logger.warn("test-category", "hello warn world");

    assert.strictEqual(warns.length, 1);
    const warnLine = warns[0];
    assert.match(
        warnLine,
        ISO_TIMESTAMP_REGEX,
        "Warn line must start with ISO 8601 timestamp",
    );
    assert.match(
        warnLine,
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[test-category\] hello warn world$/,
        "Warn line must match timestamp category and message format",
    );

    const match = warnLine.match(/^\[([^\]]+)\]/);
    assert.ok(match, "Timestamp prefix must be bracketed");
    const parsedDate = new Date(match[1]);
    assert.strictEqual(
        parsedDate.toISOString(),
        match[1],
        "Extracted timestamp must be a valid ISO string",
    );
});

test("Logger.prototype.error outputs ISO 8601 timestamp on dump headers", (t) => {
    const logger = new Logger();
    const originalLog = console.log;
    const originalError = console.error;
    t.after(() => {
        console.log = originalLog;
        console.error = originalError;
    });

    const errors: string[] = [];
    console.log = () => {};
    console.error = (...args: any[]) => {
        errors.push(args.map(String).join(" "));
    };

    logger.info("error-test", "step 1 occurred");
    logger.error("error-test", new Error("fatal failure"));

    assert.ok(
        errors.length >= 3,
        "Error dump should produce multiple log lines",
    );

    // First header: [timestamp] --- BREADCRUMBS DUMP (error-test) ---
    assert.match(
        errors[0],
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] --- BREADCRUMBS DUMP \(error-test\) ---$/,
        "Breadcrumbs dump header must include ISO timestamp",
    );

    // Breadcrumbs entry: [timestamp] [error-test] [INFO]: step 1 occurred
    assert.match(
        errors[1],
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[error-test\] \[INFO\]: step 1 occurred$/,
        "Breadcrumbs entry must include ISO timestamp",
    );

    // Error details header: [timestamp] --- ERROR DETAILS ---
    assert.match(
        errors[2],
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] --- ERROR DETAILS ---$/,
        "Error details header must include ISO timestamp",
    );
});

test("QUIET=true suppresses console output but tracks breadcrumbs", (t) => {
    const prevEnvQuiet = process.env.QUIET;
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    t.after(() => {
        if (prevEnvQuiet === undefined) {
            delete process.env.QUIET;
        } else {
            process.env.QUIET = prevEnvQuiet;
        }
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    });

    const logs: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];

    process.env.QUIET = "true";

    console.log = (msg: string) => logs.push(msg);
    console.warn = (msg: string) => warns.push(msg);
    console.error = (...args: any[]) => errors.push(args.map(String).join(" "));

    const logger = new Logger();
    assert.strictEqual(logger.isQuiet, true, "logger.isQuiet should be true");

    logger.info("quiet-cat", "suppressed info");
    logger.warn("quiet-cat", "suppressed warn");
    logger.error("quiet-cat", "suppressed error");

    assert.strictEqual(
        logs.length,
        0,
        "console.log must not be called when quiet",
    );
    assert.strictEqual(
        warns.length,
        0,
        "console.warn must not be called when quiet",
    );
    assert.strictEqual(
        errors.length,
        0,
        "console.error must not be called when quiet",
    );

    // Verify breadcrumbs are still tracked
    const breadcrumbs = logger.getBreadcrumbs();
    assert.strictEqual(
        breadcrumbs.length,
        2,
        "Breadcrumbs must still be tracked",
    );
    assert.strictEqual(breadcrumbs[0].category, "quiet-cat");
    assert.strictEqual(breadcrumbs[0].level, "info");
    assert.strictEqual(breadcrumbs[0].message, "suppressed info");
    assert.match(
        breadcrumbs[0].timestamp,
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        "Breadcrumb timestamp must be ISO 8601",
    );
    assert.strictEqual(breadcrumbs[1].category, "quiet-cat");
    assert.strictEqual(breadcrumbs[1].level, "warn");
    assert.strictEqual(breadcrumbs[1].message, "suppressed warn");
});

test("--quiet CLI argument suppresses console output but tracks breadcrumbs", (t) => {
    const originalArgv = [...process.argv];
    const originalLog = console.log;
    const originalWarn = console.warn;
    t.after(() => {
        process.argv = originalArgv;
        console.log = originalLog;
        console.warn = originalWarn;
    });

    const logs: string[] = [];
    const warns: string[] = [];

    process.argv.push("--quiet");

    console.log = (msg: string) => logs.push(msg);
    console.warn = (msg: string) => warns.push(msg);

    const logger = new Logger();
    assert.strictEqual(
        logger.isQuiet,
        true,
        "logger.isQuiet should be true with --quiet",
    );

    logger.info("cli-quiet-cat", "cli suppressed info");
    logger.warn("cli-quiet-cat", "cli suppressed warn");

    assert.strictEqual(
        logs.length,
        0,
        "console.log must not be called when quiet",
    );
    assert.strictEqual(
        warns.length,
        0,
        "console.warn must not be called when quiet",
    );

    const breadcrumbs = logger.getBreadcrumbs();
    assert.strictEqual(
        breadcrumbs.length,
        2,
        "Breadcrumbs must still be tracked",
    );
    assert.strictEqual(breadcrumbs[0].message, "cli suppressed info");
    assert.strictEqual(breadcrumbs[1].message, "cli suppressed warn");
});

test("Logger maintains a maximum of 100 breadcrumbs", () => {
    const logger = new Logger();

    for (let i = 0; i < 110; i++) {
        logger.addBreadcrumb("cat", "info", `message ${i}`);
    }

    const breadcrumbs = logger.getBreadcrumbs();
    assert.strictEqual(
        breadcrumbs.length,
        100,
        "Breadcrumb count should be capped at 100",
    );
    assert.strictEqual(
        breadcrumbs[0].message,
        "message 10",
        "Oldest breadcrumbs must have been dropped",
    );
    assert.strictEqual(
        breadcrumbs[99].message,
        "message 109",
        "Latest breadcrumb must be present",
    );
});
