import { test } from "node:test";
import assert from "node:assert";
import * as kv from "../src/kv/index";
import { getByToken, invalidateItem } from "../src/entities/index";
import { machinesTable } from "../src/entities/schema/machine";
import { add, remove } from "../src/storage/index";

test("KV - set, get, del operations", async () => {
    const testKey = "test:sample_key_" + Date.now();
    const testData = { name: "test-item", value: 12345 };

    // Initially should be null
    const initial = await kv.get(testKey);
    assert.strictEqual(initial, null);

    // Set value
    await kv.set(testKey, testData);

    // Get value back
    const retrieved = await kv.get(testKey);
    assert.deepStrictEqual(retrieved, testData);

    // Delete value
    await kv.del(testKey);

    // Should be null after delete
    const afterDel = await kv.get(testKey);
    assert.strictEqual(afterDel, null);
});

test("KV - expiration in set function", async () => {
    const testKey = "test:exp_key_" + Date.now();
    const testData = { foo: "bar" };

    // Set with 1 second expiration
    await kv.set(testKey, testData, 1);

    // Immediate get returns value
    const immediate = await kv.get(testKey);
    assert.deepStrictEqual(immediate, testData);

    // Wait 1.1 seconds for key to expire
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Get after expiration returns null
    const expired = await kv.get(testKey);
    assert.strictEqual(expired, null);
});

test("KV - getByToken and invalidateItem integration", async () => {
    const token = "token_kv_test_" + Date.now();
    const machine = await add(machinesTable, {
        token,
        version: "1.0.0",
    });

    try {
        // First getByToken populates KV cache
        const item1 = await getByToken(machinesTable, token);
        assert.ok(item1);
        assert.strictEqual(item1.token, token);

        // Verify KV has key
        const cached = await kv.get(`machines:${token}`);
        assert.ok(cached);
        assert.strictEqual((cached as any).token, token);

        // Invalidate cache
        await invalidateItem(machinesTable, token);

        // Verify KV key was deleted
        const afterInvalidate = await kv.get(`machines:${token}`);
        assert.strictEqual(afterInvalidate, null);
    } finally {
        if (machine) {
            await remove(machinesTable, machine.id);
        }
    }
});
