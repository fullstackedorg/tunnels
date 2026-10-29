import test from "node:test";
import assert from "node:assert/strict";
import { PORTS, CREDENTIALS } from "./helpers/env.ts";
import { waitForRedis } from "./helpers/compose.ts";
import { RedisKVProvider } from "../../src/kv/redis.ts";

test("kv-redis: mget reads keys in order with MGET, missing as null", async () => {
    await waitForRedis();
    const kv = new RedisKVProvider(
        `redis://:${CREDENTIALS.redis.password}@127.0.0.1:${PORTS.redis}`
    );
    const prefix = `kv-redis-test:${process.pid}:`;
    try {
        assert.deepEqual(await kv.mget([]), []);
        await kv.set(`${prefix}obj`, { a: 1 }, 30);
        await kv.set(`${prefix}str`, "three", 30);
        assert.deepEqual(await kv.mget([`${prefix}obj`, `${prefix}none`, `${prefix}str`]), [
            { a: 1 },
            null,
            "three",
        ]);
    } finally {
        await kv.del([`${prefix}obj`, `${prefix}str`]);
        await kv.close();
    }
});
