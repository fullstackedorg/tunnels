import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/utils/config.ts";
import { configNotices } from "../src/utils/config-notices.ts";

test("config: default settings in Hub mode", () => {
    const config = parseConfig([], {});
    assert.equal(config.isEdge, false);
    assert.equal(config.port, 3000);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.workers, 1);
    assert.equal(config.heartbeatInterval, 10);
    assert.equal(config.heartbeatTimeout, 30);
    assert.equal(config.connectTimeout, 10);
    assert.equal(config.dataDir, "data");
    assert.equal(config.logLevel, "info");
    assert.equal(config.logFormat, "text");
});

test("config: CLI flags override environment variables and defaults", () => {
    const config = parseConfig(["--port", "8080", "-w", "2", "--allow-fs-multiworker"], {
        PORT: "9000",
        WORKERS: "4",
    });
    assert.equal(config.port, 8080);
    assert.equal(config.workers, 2);
    assert.equal(config.allowFsMultiworker, true);
});

test("config: environment variables override defaults", () => {
    const config = parseConfig([], {
        PORT: "4000",
        HOST: "127.0.0.1",
        CONNECT_TIMEOUT: "15",
        LOG_LEVEL: "debug",
        LOG_FORMAT: "json",
    });
    assert.equal(config.port, 4000);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.connectTimeout, 15);
    assert.equal(config.logLevel, "debug");
    assert.equal(config.logFormat, "json");
});

test("config: quiet flag sets log level to warn", () => {
    const config = parseConfig(["-q"], { LOG_LEVEL: "info" });
    assert.equal(config.quiet, true);
    assert.equal(config.logLevel, "warn");
});

test("config: Edge mode detection from HUB_URL or --hub-url", () => {
    const edgeCli = parseConfig(["--hub-url", "wss://example.com", "--token", "edg_test123"]);
    assert.equal(edgeCli.isEdge, true);
    assert.equal(edgeCli.hubUrl, "wss://example.com");
    assert.equal(edgeCli.token, "edg_test123");

    const edgeEnv = parseConfig([], { HUB_URL: "ws://localhost:3000", TOKEN: "edg_env" });
    assert.equal(edgeEnv.isEdge, true);
    assert.equal(edgeEnv.token, "edg_env");
});

test("config: validation throws when WORKERS > 1 without DB/Redis or ALLOW_FILESYSTEM_MULTIWORKER", () => {
    assert.throws(
        () => {
            parseConfig(["--workers", "4"], {});
        },
        {
            message: /Startup error: WORKERS > 1 requires PostgreSQL/,
        }
    );

    // Passes when allowFsMultiworker is enabled
    const valid = parseConfig(["--workers", "4", "--allow-fs-multiworker"], {});
    assert.equal(valid.workers, 4);
    assert.equal(valid.allowFsMultiworker, true);
});

test("config: ALLOW_FILESYSTEM_MULTIWORKER notices follow the Test Mode rules", () => {
    const base = ["--allow-fs-multiworker"];
    const warnMsg =
        "ALLOW_FILESYSTEM_MULTIWORKER is enabled: file-backed shared storage/KV is for tests only (slow, global file lock, not durable).";

    assert.deepEqual(configNotices(parseConfig(["--workers", "2", ...base], {}), {}), [
        { level: "warn", message: warnMsg },
    ]);
    assert.deepEqual(
        configNotices(parseConfig(["--workers", "2", ...base], {}), { NODE_ENV: "production" }),
        [{ level: "error", message: warnMsg }]
    );

    const ignored = configNotices(parseConfig(base, {}), {});
    assert.equal(ignored.length, 1);
    assert.equal(ignored[0].level, "info");
    assert.match(ignored[0].message, /ignored/);

    const both = configNotices(
        parseConfig(
            [
                "--workers",
                "2",
                "--postgres-url",
                "postgres://x",
                "--redis-url",
                "redis://x",
                ...base,
            ],
            {}
        ),
        {}
    );
    assert.equal(both.length, 1);
    assert.equal(both[0].level, "info");

    assert.deepEqual(configNotices(parseConfig([], {}), {}), []);
});
