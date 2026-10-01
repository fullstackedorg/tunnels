import test from "node:test";
import assert from "node:assert/strict";
import { validateEntityPayload } from "../src/entities/validation.ts";
import { resolveToken, cacheRollToken, cacheDeleteEntity } from "../src/entities/cache.ts";
import { FilesystemStorageProvider } from "../src/storage/filesystem.ts";
import { setStorage } from "../src/storage/index.ts";
import { MemoryKVProvider } from "../src/kv/memory.ts";
import { initKV, setKV } from "../src/kv/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import {
    SpyKV,
    cleanupTempDir,
    connectTestWs,
    createTempDir,
    createTunnel,
    startTestHub,
} from "./helpers.ts";
import type { Tunnel } from "../src/entities/schema.ts";

test("entities: validation disallows client-provided id, token, and version", () => {
    const withId = validateEntityPayload("tunnel", {
        id: "custom-id",
        name: "test",
        internalHost: "localhost",
        internalPort: 8080,
    });
    assert.equal(withId.valid, false);
    assert.ok(withId.fields?.id);

    const withToken = validateEntityPayload("tunnel", {
        token: "tun_custom",
        name: "test",
        internalHost: "localhost",
        internalPort: 8080,
    });
    assert.equal(withToken.valid, false);
    assert.ok(withToken.fields?.token);

    const withVersion = validateEntityPayload("edge", { version: "1.0.0", name: "test" });
    assert.equal(withVersion.valid, false);
    assert.ok(withVersion.fields?.version);
});

test("entities: validation requires valid host and port", () => {
    const invalidPort = validateEntityPayload("tunnel", {
        name: "test",
        internalHost: "localhost",
        internalPort: 70000,
    });
    assert.equal(invalidPort.valid, false);
    assert.ok(invalidPort.fields?.internalPort);

    const invalidHost = validateEntityPayload("tunnel", {
        name: "test",
        internalHost: "invalid host @!#",
        internalPort: 8080,
    });
    assert.equal(invalidHost.valid, false);
    assert.ok(invalidHost.fields?.internalHost);
});

test("entities: token resolution caches positive result and negative tombstones", async () => {
    const dir = createTempDir("entity-cache-");
    const testStorage = new FilesystemStorageProvider(dir);
    const testKv = new MemoryKVProvider();
    setStorage(testStorage);
    setKV(testKv);

    try {
        const added = (await testStorage.add("tunnel", {
            token: "tun_resolved_token",
            name: "Cache Tunnel",
            internalHost: "127.0.0.1",
            internalPort: 8080,
            edgeId: null,
            metadata: {},
        })) as Tunnel;

        // 1. Initial resolution (hits storage and writes to KV positive cache)
        const res1 = await resolveToken(added.token);
        assert.ok(res1);
        assert.equal(res1.type, "tunnel");
        assert.equal(res1.entity.id, added.id);

        // Verify positive cache key is set
        const inCache = await testKv.get(`entity:tunnel:${added.token}`);
        assert.ok(inCache);

        // 2. Unknown token resolution (writes negative tombstone)
        const missing = await resolveToken("tun_unknown_token");
        assert.equal(missing, null);

        const tombstone = await testKv.get("entity:miss:tun_unknown_token");
        assert.equal(tombstone, 1);

        // 3. Roll token: writes new token to cache, invalidates old token with tombstone
        const oldToken = added.token;
        const newToken = "tun_rolled_token";
        const rolledEntity = { ...added, token: newToken };
        await cacheRollToken("tunnel", rolledEntity, oldToken);

        const oldLookup = await resolveToken(oldToken);
        assert.equal(oldLookup, null); // Hit negative tombstone

        const newLookup = await resolveToken(newToken);
        assert.ok(newLookup);
        assert.equal(newLookup.entity.token, newToken);

        // 4. Delete entity
        await cacheDeleteEntity("tunnel", newToken);
        const afterDelete = await resolveToken(newToken);
        assert.equal(afterDelete, null);
    } finally {
        await testStorage.close();
        await testKv.close();
        setStorage(null);
        setKV(null);
        cleanupTempDir(dir);
    }
});

test("entities: ENTITY_CACHE_TTL and NEGATIVE_CACHE_TTL are applied to the token cache", async () => {
    const h = await startTestHub(["--entity-cache-ttl", "9", "--negative-cache-ttl", "2"]);
    const spy = new SpyKV(initKV(parseConfig([])));
    setKV(spy);
    try {
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 1,
        });
        assert.equal(spy.sets.find((s) => s.key === `entity:tunnel:${tunnel.token}`)?.ttl, 9);

        await assert.rejects(
            connectTestWs(`ws://127.0.0.1:${h.port}/`, {
                headers: { Authorization: "tun_unknown" },
            })
        );
        assert.equal(spy.sets.find((s) => s.key === "entity:miss:tun_unknown")?.ttl, 2);
    } finally {
        await h.close();
    }
});
