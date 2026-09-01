import assert from "node:assert";
import { before, after, suite, test } from "node:test";
import { startDockerCompose, stopDockerCompose } from "./helpers/compose.ts";
import { startFullStacked, stopFullStacked, runTestWithFullStacked } from "./helpers/fullstacked.ts";
import path from "node:path";
import fs from "node:fs";
import { tmpDir, samplesDir } from "./helpers/paths.ts";

const samplesTmpDir = path.join(tmpDir, "testing.fullstacked.direct");

suite("fullstacked direct tests", () => {
    before(async () => {
        await Promise.all([
            startDockerCompose(),
            startFullStacked(),
            fs.promises.cp(samplesDir, samplesTmpDir, { recursive: true })
        ])
    });

    after(async () => {
        await Promise.all([
            stopDockerCompose(),
            stopFullStacked(),
            fs.promises.rm(samplesTmpDir, { recursive: true, force: true })
        ])
    })

    test("mysql", async () => {
        const testData = { mysql: "testing.fullstacked.direct" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "mysql"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("mongodb", async () => {
        const testData = { mongodb: "testing.fullstacked.direct" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "mongodb"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("postgresql", async () => {
        const testData = { postgresql: "testing.fullstacked.direct" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "postgresql"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("redis", async () => {
        const testData = { redis: "testing.fullstacked.direct" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "redis"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("s3", async () => {
        const testData = { s3: "testing.fullstacked.direct" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "s3"), testData)
        assert.deepStrictEqual(result, testData);
    });

    test("git-server", async () => {
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "git-server"), "fullstacked.direct.git")
        assert.strictEqual(result, "test file");
    });
});