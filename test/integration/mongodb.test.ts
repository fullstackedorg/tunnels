import test from "node:test";
import { PORTS, CREDENTIALS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runProgrammatic } from "./helpers/runtime.ts";
import { waitForMongo } from "./helpers/compose.ts";

test("mongodb: OP_MSG wire protocol, BSON serialization, and query cursor streaming over direct tunnel", async () => {
    await waitForMongo();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.mongo,
            "127.0.0.1",
            "MongoDB Direct"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import { MongoClient, ObjectId, Binary } from "mongodb";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const mongoUri = \`mongodb://${CREDENTIALS.mongo.username}:${CREDENTIALS.mongo.password}@\${host}:27017/test_db?authSource=admin&directConnection=true\`;
            const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
            await client.connect();

            const db = client.db("test_db");
            const collection = db.collection("direct_items");
            await collection.deleteMany({});

            // 1. BSON serialization & OP_MSG insertion
            const docId = new ObjectId();
            const binaryData = new Binary(Buffer.from("bson-payload-12345"));
            const insertRes = await collection.insertOne({
                _id: docId,
                title: "BSON Document",
                created: new Date("2026-01-01T00:00:00Z"),
                data: binaryData,
                nested: { level1: { level2: [1, 2, 3] } },
            });
            assert.equal(insertRes.acknowledged, true);

            const found = await collection.findOne({ _id: docId });
            assert.ok(found);
            assert.equal(found.title, "BSON Document");
            assert.deepEqual(found.nested.level1.level2, [1, 2, 3]);

            // 2. Query Cursor Streaming with 100 documents
            const docs = Array.from({ length: 100 }, (_, i) => ({
                index: i,
                str: \`stream-item-\${i}\`,
                randomBytes: new Binary(Buffer.alloc(256, i % 256)),
            }));
            await collection.insertMany(docs);

            const cursor = collection.find({ index: { $gte: 0 } }).sort({ index: 1 });
            let count = 0;
            for await (const item of cursor) {
                assert.equal(item.index, count);
                count++;
            }
            assert.equal(count, 100);

            await client.close();
        `);
    } finally {
        await harness.close();
    }
});

test("mongodb: document operations and connection pooling over edge relayed tunnel", async () => {
    await waitForMongo();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.mongo,
            "127.0.0.1",
            "MongoDB Relayed"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import { MongoClient } from "mongodb";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const mongoUri = \`mongodb://${CREDENTIALS.mongo.username}:${CREDENTIALS.mongo.password}@\${host}:27017/test_relayed_db?authSource=admin&directConnection=true\`;
            const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
            await client.connect();

            const db = client.db("test_relayed_db");
            const collection = db.collection("relayed_items");
            await collection.deleteMany({});

            await collection.insertOne({ status: "relayed-init", count: 1 });
            const updated = await collection.findOneAndUpdate(
                { status: "relayed-init" },
                { $inc: { count: 9 } },
                { returnDocument: "after" }
            );
            assert.equal(updated?.count, 10);

            // Connection pooling: concurrent operations across pooled sockets
            const poolOps = await Promise.all(
                Array.from({ length: 10 }, (_, i) =>
                    collection.insertOne({ poolId: i, created: Date.now() })
                )
            );
            assert.equal(poolOps.length, 10);
            assert.ok(poolOps.every((res) => res.acknowledged));

            const poolCount = await collection.countDocuments({ poolId: { $exists: true } });
            assert.equal(poolCount, 10);

            await client.close();
        `);
    } finally {
        await harness.close();
    }
});
