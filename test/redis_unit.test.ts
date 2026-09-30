import test from "node:test";
import assert from "node:assert/strict";
import { RedisKVProvider } from "../src/kv/redis.ts";

test("redis_unit: RedisKVProvider full suite with mock client", async () => {
    const provider = new RedisKVProvider("redis://127.0.0.1:6379");
    const store = new Map<string, string>();
    const sets = new Map<string, Set<string>>();

    const mockClient: any = {
        connect: async () => {},
        get: async (key: string) => store.get(key) ?? null,
        set: async (key: string, val: string, opt?: any) => {
            if (opt?.NX && store.has(key)) return null;
            store.set(key, val);
            return "OK";
        },
        getDel: async (key: string) => {
            const v = store.get(key) ?? null;
            store.delete(key);
            return v;
        },
        del: async (keys: string[]) => {
            for (const k of keys) store.delete(k);
        },
        eval: async (_script: string, opt: any) => {
            const key = opt.keys[0];
            const expected = opt.arguments[0];
            if (store.get(key) === expected) {
                store.delete(key);
                return 1;
            }
            return 0;
        },
        sAdd: async (key: string, member: string) => {
            if (!sets.has(key)) sets.set(key, new Set());
            sets.get(key)!.add(member);
        },
        sRem: async (key: string, member: string) => {
            sets.get(key)?.delete(member);
        },
        sMembers: async (key: string) => {
            return Array.from(sets.get(key) || []);
        },
        quit: async () => {},
    };

    (provider as any).client = mockClient;

    // 1. set and get (with string and JSON)
    await provider.set("key1", "plain-string");
    const val1 = await provider.get<string>("key1");
    assert.equal(val1, "plain-string");

    await provider.set("key2", { foo: "bar", count: 42 }, 10);
    const val2 = await provider.get<{ foo: string; count: number }>("key2");
    assert.deepEqual(val2, { foo: "bar", count: 42 });

    // 2. setNX
    const nx1 = await provider.setNX("nxKey", "first", 10);
    assert.equal(nx1, true);
    const nx2 = await provider.setNX("nxKey", "second", 10);
    assert.equal(nx2, false);

    // 3. getdel
    const delVal = await provider.getdel<{ foo: string }>("key2");
    assert.deepEqual(delVal, { foo: "bar", count: 42 });
    const afterDel = await provider.get("key2");
    assert.equal(afterDel, null);

    // 4. del
    await provider.del(["key1", "nxKey"]);
    assert.equal(await provider.get("key1"), null);
    assert.equal(await provider.get("nxKey"), null);
    await provider.del([]); // empty list noop

    // 5. delIfEquals
    await provider.set("dieKey", "matchMe");
    const diffMatch = await provider.delIfEquals("dieKey", "wrongVal");
    assert.equal(diffMatch, false);
    assert.equal(await provider.get("dieKey"), "matchMe");

    const exactMatch = await provider.delIfEquals("dieKey", "matchMe");
    assert.equal(exactMatch, true);
    assert.equal(await provider.get("dieKey"), null);

    // 6. sets (sadd, srem, smembers)
    await provider.sadd("setKey", "item1");
    await provider.sadd("setKey", "item2");
    let members = await provider.smembers("setKey");
    assert.equal(members.length, 2);
    assert.ok(members.includes("item1"));
    assert.ok(members.includes("item2"));

    await provider.srem("setKey", "item1");
    members = await provider.smembers("setKey");
    assert.equal(members.length, 1);
    assert.equal(members[0], "item2");

    // 7. close
    await provider.close();
    assert.equal((provider as any).isConnected, false);
});
