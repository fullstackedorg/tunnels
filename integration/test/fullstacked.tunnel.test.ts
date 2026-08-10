import assert from "node:assert";
import { before, after, suite, test } from "node:test";
import { startDockerCompose, stopDockerCompose } from "./helpers/compose";
import { startFullStacked, stopFullStacked, runTestWithFullStacked } from "./helpers/fullstacked";
import { addProxy, addService, startTunnelServer, stopTunnelServer } from "./helpers/tunnel.ts";
import { randomPort } from "./helpers/port.ts";
import path from "node:path";
import { samplesDir, tmpDir } from "./helpers/paths.ts";
import { randomString } from "./helpers/string.ts";
import fs from "node:fs";

const samplesTmpDir = path.join(tmpDir, "testing.fullstacked.tunnel");

const tunnelServerPort = randomPort();
const tunnelServerDataDir = path.join(tmpDir, randomString());

suite("fullstacked tunnel tests", () => {
    before(async () => {
        await Promise.all([
            startDockerCompose(),
            startFullStacked(),
            startTunnelServer(tunnelServerPort, tunnelServerDataDir),
            await fs.promises.cp(samplesDir, samplesTmpDir, { recursive: true })
        ])
    });

    after(async () => {
        await Promise.all([
            stopDockerCompose(),
            stopFullStacked(),
            stopTunnelServer(),
            fs.promises.rm(tunnelServerDataDir, { recursive: true, force: true }),
            fs.promises.rm(samplesTmpDir, { recursive: true, force: true })
        ]);
    });

    test("mysql", async () => {
        globalThis.tunnel = await addService(tunnelServerPort, "fullstacked.tunnel.mysql", Number(process.env.MYSQL_PORT));
        const testData = { mysql: "testing.fullstacked.tunnel" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "mysql"), testData);
        assert.deepStrictEqual(result, testData);
    });

    test("mongodb", async () => {
        globalThis.tunnel = await addService(tunnelServerPort, "fullstacked.tunnel.mongodb", Number(process.env.MONGODB_PORT));
        const testData = { mongodb: "testing.fullstacked.tunnel" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "mongodb"), testData);
        assert.deepStrictEqual(result, testData);
    });

    test("postgresql", async () => {
        globalThis.tunnel = await addService(tunnelServerPort, "fullstacked.tunnel.postgresql", Number(process.env.POSTGRES_PORT));
        const testData = { postgresql: "testing.fullstacked.tunnel" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "postgresql"), testData);
        assert.deepStrictEqual(result, testData);
    });

    test("redis", async () => {
        globalThis.tunnel = await addService(tunnelServerPort, "fullstacked.tunnel.redis", Number(process.env.REDIS_PORT));
        const testData = { redis: "testing.fullstacked.tunnel" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "redis"), testData);
        assert.deepStrictEqual(result, testData);
    });

    test("s3", async () => {
        globalThis.tunnel = await addService(tunnelServerPort, "fullstacked.tunnel.s3", Number(process.env.S3_PORT));
        const testData = { s3: "testing.fullstacked.tunnel" }
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "s3"), testData);
        assert.deepStrictEqual(result, testData);
    });

    test("git-server", async () => {
        globalThis.tunnel = await addService(tunnelServerPort, "fullstacked.tunnel.git", Number(process.env.GIT_SERVER_PORT));
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "git-server"), "fullstacked.tunnel.git");
        assert.strictEqual(result, "test file");
    });

    test("git-proxy", async () => {
        const name = "fullstacked-git-proxy";
        globalThis.proxy = await addProxy(tunnelServerPort, {
            name,
            urlProtocol: "http",
            urlHost: "127.0.0.1",
            urlPort: Number(process.env.GIT_SERVER_PORT),
            headers: {
                authorization: `Basic ${Buffer.from(`${process.env.USERNAME}:${process.env.PASSWORD}`).toString("base64")}`
            }
        });
        const result = await runTestWithFullStacked(path.join(samplesTmpDir, "git-proxy"), "fullstacked.tunnel.git.proxy");
        assert.strictEqual(result, "test file");
    });

});