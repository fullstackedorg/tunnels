import assert from "node:assert";
import { before, after, suite, test } from "node:test";
import { startDockerCompose, stopDockerCompose } from "./helpers/compose.ts";
import { startFullStacked, stopFullStacked, runTestWithFullStackedInBrowser } from "./helpers/fullstacked.ts";
import { stopAllBrowsers } from "../fullstacked/test/browser.ts";
import fs from "node:fs";
import path from "node:path";
import { samplesDir, tmpDir } from "./helpers/paths.ts";

const samplesTmpDir = path.join(tmpDir, "testing.fullstacked.browser.direct");

suite("fullstacked browser direct tests", () => {
    before(async () => {
        await Promise.all([
            fs.promises.cp(samplesDir, samplesTmpDir, { recursive: true }),
            startDockerCompose(),
            startFullStacked()
        ])
    });

    after(async () => {
        await Promise.all([
            stopAllBrowsers(),
            stopDockerCompose(),
            stopFullStacked(),
            fs.promises.rm(samplesTmpDir, { recursive: true, force: true })
        ])
    });

    test("mysql", async () => {
        const testData = { mysql: "testing.fullstacked.browser.direct" }
        const result = await runTestWithFullStackedInBrowser(path.join(samplesTmpDir, "mysql"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("mongodb", async () => {
        const testData = { mongodb: "testing.fullstacked.browser.direct" }
        const result = await runTestWithFullStackedInBrowser(path.join(samplesTmpDir, "mongodb"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("postgresql", async () => {
        const testData = { postgresql: "testing.fullstacked.browser.direct" }
        const result = await runTestWithFullStackedInBrowser(path.join(samplesTmpDir, "postgresql"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("redis", async () => {
        const testData = { redis: "testing.fullstacked.browser.direct" }
        const result = await runTestWithFullStackedInBrowser(path.join(samplesTmpDir, "redis"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("s3", async () => {
        const testData = { s3: "testing.fullstacked.browser.direct" }
        const result = await runTestWithFullStackedInBrowser(path.join(samplesTmpDir, "s3"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("git-server", async () => {
        const result = await runTestWithFullStackedInBrowser(path.join(samplesTmpDir, "git-server"), "fullstacked.browser.direct.git")
        assert.strictEqual(result, "test file");
    });
});