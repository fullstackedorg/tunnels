import test from "node:test";
import { PORTS, CREDENTIALS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runProgrammatic } from "./helpers/runtime.ts";
import { waitForRedis } from "./helpers/compose.ts";

test("redis: basic caching commands and Pub/Sub over direct tunnel", async () => {
    await waitForRedis();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.redis,
            "127.0.0.1",
            "Redis Direct"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import { createClient } from "redis";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const client = createClient({
                url: \`redis://:${CREDENTIALS.redis.password}@\${host}:6379\`,
            });
            await client.connect();

            // 1. Basic commands
            await client.set("integ:foo", "bar");
            const val = await client.get("integ:foo");
            assert.equal(val, "bar");

            await client.hSet("integ:hash", { field1: "val1", field2: "val2" });
            const hash = await client.hGetAll("integ:hash");
            assert.equal(hash.field1, "val1");
            assert.equal(hash.field2, "val2");

            // 2. High-throughput Pub/Sub
            const subClient = client.duplicate();
            await subClient.connect();

            const receivedMessages: string[] = [];
            await subClient.subscribe("integ:channel", (msg) => {
                receivedMessages.push(msg);
            });

            for (let i = 0; i < 5; i++) {
                await client.publish("integ:channel", \`msg-\${i}\`);
            }

            for (let i = 0; i < 50; i++) {
                if (receivedMessages.length >= 5) break;
                await new Promise((r) => setTimeout(r, 20));
            }

            assert.equal(receivedMessages.length, 5);
            assert.equal(receivedMessages[0], "msg-0");
            assert.equal(receivedMessages[4], "msg-4");

            await subClient.disconnect();
            await client.disconnect();
        `);
    } finally {
        await harness.close();
    }
});

test("redis: caching and multiplexing over edge relayed tunnel", async () => {
    await waitForRedis();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.redis,
            "127.0.0.1",
            "Redis Relayed"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import { createClient } from "redis";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const client = createClient({
                url: \`redis://:${CREDENTIALS.redis.password}@\${host}:6379\`,
            });
            await client.connect();

            // 1. Multiplexing sequential commands over same connection
            await client.set("integ:relayed", "100");
            const incrRes = await client.incr("integ:relayed");
            assert.equal(incrRes, 101);

            const got = await client.get("integ:relayed");
            assert.equal(got, "101");

            // 2. Distributed cluster coordination: atomic lock acquisition and mutual exclusion
            const lockKey = "integ:cluster:leader";
            const lockAcquired = await client.set(lockKey, "worker-1", { NX: true, EX: 10 });
            assert.equal(lockAcquired, "OK");

            const lockContended = await client.set(lockKey, "worker-2", { NX: true, EX: 10 });
            assert.equal(lockContended, null);

            await client.del(lockKey);
            const lockReacquired = await client.set(lockKey, "worker-2", { NX: true, EX: 10 });
            assert.equal(lockReacquired, "OK");
            await client.del(lockKey);

            await client.disconnect();
        `);
    } finally {
        await harness.close();
    }
});
