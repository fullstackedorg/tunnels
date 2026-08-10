import assert from "node:assert";
import { before, after, suite, test } from "node:test";
import { startDockerCompose, stopDockerCompose } from "./helpers/compose.ts";
import { testMongoDB } from "./samples/mongodb/test.ts";
import { testPostgreSQL } from "./samples/postgresql/test.ts";
import { testRedis } from "./samples/redis/test.ts";
import { testMySQL } from "./samples/mysql/test.ts";
import { testS3 } from "./samples/s3/test.ts";
import { testGitServer } from "./samples/git-server/test.child_process.ts";

suite("direct tests", () => {
    before(async () => {
        await startDockerCompose();
    });

    after(async () => {
        await stopDockerCompose();
    });

    test("mongodb", async () => {
        const testData = { mongodb: "testing.direct" }
        const mongoResult = await testMongoDB(
            Number(process.env.MONGODB_PORT!),
            process.env.USERNAME!,
            process.env.PASSWORD!,
            testData
        );
        assert.deepEqual(mongoResult, testData);
    });

    test("postgresql", async () => {
        const testData = { postgresql: "testing.direct" }
        const postgresResult = await testPostgreSQL(
            Number(process.env.POSTGRES_PORT!),
            process.env.USERNAME!,
            process.env.PASSWORD!,
            testData
        );
        assert.deepEqual(postgresResult, testData);
    });

    test("redis", async () => {
        const testData = { redis: "testing.direct" }
        const redisResult = await testRedis(
            Number(process.env.REDIS_PORT!),
            process.env.PASSWORD!,
            testData
        );
        assert.deepEqual(redisResult, testData);
    });

    test("mysql", async () => {
        const testData = { mysql: "testing.direct" }
        const mysqlResult = await testMySQL(
            Number(process.env.MYSQL_PORT!),
            process.env.PASSWORD!,
            testData
        );
        assert.deepEqual(mysqlResult, testData);
    });

    test("s3", async () => {
        const testData = { s3: "testing.direct" }
        const s3Result = await testS3(
            Number(process.env.S3_PORT!),
            process.env.USERNAME!,
            process.env.PASSWORD!,
            testData
        );
        assert.deepEqual(s3Result, testData);
    });

    test("git-server", async () => {
        const gitResult = await testGitServer(
            Number(process.env.GIT_SERVER_PORT!),
            process.env.USERNAME!,
            process.env.PASSWORD!,
            "direct.git"
        );
        assert.strictEqual(gitResult, "test file");
    });
});