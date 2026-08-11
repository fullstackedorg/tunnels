import { test } from "node:test";
import assert from "node:assert";
import cluster from "node:cluster";
import * as kv from "../src/kv/index";
import {
    cleanExpiredFileSystemKeys,
    startCleanupInterval,
    stopCleanupInterval,
} from "../src/kv/filesystem";
import { getByToken, invalidateItem } from "../src/entities/index";
import { machinesTable } from "../src/entities/schema/machine";
import { add, remove } from "../src/storage/index";
import { slugify } from "../src/utils/slugify";

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

test("KV - slugify function", () => {
    assert.strictEqual(
        slugify("machines:token_kv_test_123"),
        "machines-token_kv_test_123",
    );
    assert.strictEqual(
        slugify("  Hello World! -- @2026/08/10  "),
        "hello-world-2026-08-10",
    );
    assert.strictEqual(
        slugify("Café & Crème / Special #1"),
        "cafe-creme-special-1",
    );
    assert.strictEqual(slugify("!!!"), "file");
    assert.strictEqual(slugify(""), "file");
});

test("KV - cleanExpiredFileSystemKeys cleans expired keys", async () => {
    const key = "test:cleanup_exp_" + Date.now();
    await kv.set(key, { data: "cleanup-test" }, 1);

    // Immediately available
    const immediate = await kv.get(key);
    assert.deepStrictEqual(immediate, { data: "cleanup-test" });

    // Wait 1.1 seconds for expiration
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Run cleanExpiredFileSystemKeys
    const deletedCount = await cleanExpiredFileSystemKeys();
    assert.ok(deletedCount >= 1);

    const afterClean = await kv.get(key);
    assert.strictEqual(afterClean, null);
});

test("KV - start and stop cleanup interval", () => {
    const timer = startCleanupInterval(500);
    assert.ok(timer);
    stopCleanupInterval();
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
