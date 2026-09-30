import test from "node:test";
import assert from "node:assert/strict";
import { MemoryKVProvider } from "../src/kv/memory.ts";
import { FileKVProvider } from "../src/kv/filesystem.ts";
import { createTempDir, cleanupTempDir } from "./helpers.ts";
import type { KVProvider } from "../src/kv/interface.ts";

function runKVSuite(
    name: string,
    getProvider: () => Promise<{ provider: KVProvider; cleanup: () => Promise<void> }>
) {
    test(`kv [${name}]: set, get, and del`, async () => {
        const { provider, cleanup } = await getProvider();
        try {
            await provider.set("key1", { hello: "world" });
            const val = await provider.get("key1");
            assert.deepEqual(val, { hello: "world" });

            await provider.del("key1");
            const afterDel = await provider.get("key1");
            assert.equal(afterDel, null);
        } finally {
            await cleanup();
        }
    });

    test(`kv [${name}]: setNX semantics`, async () => {
        const { provider, cleanup } = await getProvider();
        try {
            const first = await provider.setNX("nx_key", "value1", 10);
            assert.equal(first, true);

            const second = await provider.setNX("nx_key", "value2", 10);
            assert.equal(second, false);

            const val = await provider.get("nx_key");
            assert.equal(val, "value1");
        } finally {
            await cleanup();
        }
    });

    test(`kv [${name}]: getdel atomically returns and removes key`, async () => {
        const { provider, cleanup } = await getProvider();
        try {
            await provider.set("gd_key", "ticket_data");
            const claimed = await provider.getdel("gd_key");
            assert.equal(claimed, "ticket_data");

            const secondClaim = await provider.getdel("gd_key");
            assert.equal(secondClaim, null);
        } finally {
            await cleanup();
        }
    });

    test(`kv [${name}]: delIfEquals only deletes if value matches`, async () => {
        const { provider, cleanup } = await getProvider();
        try {
            await provider.set("lock_key", "worker-1");

            const failed = await provider.delIfEquals("lock_key", "worker-2");
            assert.equal(failed, false);

            const stillThere = await provider.get("lock_key");
            assert.equal(stillThere, "worker-1");

            const success = await provider.delIfEquals("lock_key", "worker-1");
            assert.equal(success, true);

            const afterDel = await provider.get("lock_key");
            assert.equal(afterDel, null);
        } finally {
            await cleanup();
        }
    });

    test(`kv [${name}]: sadd, srem, and smembers`, async () => {
        const { provider, cleanup } = await getProvider();
        try {
            await provider.sadd("set_key", "itemA");
            await provider.sadd("set_key", "itemB");
            await provider.sadd("set_key", "itemA"); // duplicate

            const members = await provider.smembers("set_key");
            assert.equal(members.length, 2);
            assert.ok(members.includes("itemA"));
            assert.ok(members.includes("itemB"));

            await provider.srem("set_key", "itemA");
            const afterRem = await provider.smembers("set_key");
            assert.equal(afterRem.length, 1);
            assert.equal(afterRem[0], "itemB");
        } finally {
            await cleanup();
        }
    });
}

runKVSuite("MemoryKVProvider", async () => {
    const provider = new MemoryKVProvider();
    return {
        provider,
        cleanup: async () => {
            await provider.close();
        },
    };
});

runKVSuite("FileKVProvider", async () => {
    const dir = createTempDir("file-kv-");
    const provider = new FileKVProvider(dir);
    return {
        provider,
        cleanup: async () => {
            await provider.close();
            cleanupTempDir(dir);
        },
    };
});
