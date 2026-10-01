import test from "node:test";
import assert from "node:assert/strict";
import { initStorage, setStorage } from "../src/storage/index.ts";
import type { StorageProvider } from "../src/storage/interface.ts";
import { parseConfig } from "../src/utils/config.ts";
import { registerHook, clearHooks } from "../src/utils/hooks.ts";
import { createEdge, createTunnel, jsonFetch, startTestHub } from "./helpers.ts";

function failingStorage(makeError: () => Error): StorageProvider {
    const fail = async () => {
        throw makeError();
    };
    return {
        list: fail,
        find: fail,
        get: fail,
        getByToken: fail,
        add: fail,
        update: fail,
        remove: fail,
        transaction: fail,
        close: async () => {},
    } as unknown as StorageProvider;
}

test("api-errors: storage unavailable returns 503, unexpected errors return a generic 500", async () => {
    const h = await startTestHub();
    const real = await initStorage(parseConfig([]));
    try {
        const tunnel = await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 1,
        });

        setStorage(
            failingStorage(() =>
                Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
            )
        );
        for (const [method, path] of [
            ["GET", "/tunnels"],
            ["GET", `/tunnels/${tunnel.id}`],
            ["DELETE", `/tunnels/${tunnel.id}`],
            ["POST", `/tunnels/${tunnel.id}/roll-token`],
            ["GET", "/edges"],
        ]) {
            const res = await jsonFetch(`${h.baseUrl}${path}`, { method });
            assert.equal(res.status, 503, `${method} ${path}`);
            assert.deepEqual(res.data, { error: "Service Unavailable" });
        }

        setStorage(failingStorage(() => new Error("secret internal detail")));
        const res = await jsonFetch(`${h.baseUrl}/tunnels`);
        assert.equal(res.status, 500);
        assert.deepEqual(res.data, { error: "Internal Server Error" });
    } finally {
        setStorage(real);
        await h.close();
    }
});

test("api-errors: request bodies over 1 MiB return 413", async () => {
    const h = await startTestHub();
    try {
        const res = await jsonFetch(`${h.baseUrl}/tunnels`, {
            method: "POST",
            body: JSON.stringify({ name: "x".repeat(1024 * 1024 + 10) }),
        });
        assert.equal(res.status, 413);
        assert.deepEqual(res.data, { error: "Payload Too Large" });
    } finally {
        await h.close();
    }
});

test("api-errors: unknown filter and sort columns return 400; default order is id:asc", async () => {
    const h = await startTestHub();
    try {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const t = await createTunnel(h.baseUrl, {
                internalHost: "127.0.0.1",
                internalPort: 1000 + i,
                metadata: { team: i % 2 ? "odd" : "even" },
            });
            ids.push(t.id);
        }

        const list = await jsonFetch(`${h.baseUrl}/tunnels`);
        assert.deepEqual(
            list.data.map((t: any) => t.id),
            [...ids].sort()
        );

        const bad = await jsonFetch(`${h.baseUrl}/tunnels?nope=1`);
        assert.equal(bad.status, 400);
        const badSort = await jsonFetch(`${h.baseUrl}/tunnels?orderBy=nope:desc`);
        assert.equal(badSort.status, 400);
        const edgeCol = await jsonFetch(`${h.baseUrl}/edges?internalPort=5432`);
        assert.equal(edgeCol.status, 400);

        const byMeta = await jsonFetch(`${h.baseUrl}/tunnels?metadata.team=odd`);
        assert.equal(byMeta.status, 200);
        assert.equal(byMeta.data.length, 2);
        const byPort = await jsonFetch(`${h.baseUrl}/tunnels?internalPort=1003&orderBy=name:desc`);
        assert.equal(byPort.data.length, 1);
        assert.equal(byPort.headers.get("x-total-count"), "1");
    } finally {
        await h.close();
    }
});

test("api-errors: a cascaded child delete_tunnel denial returns the hook's 403 Denied body", async () => {
    clearHooks();
    const h = await startTestHub();
    try {
        const edge = await createEdge(h.baseUrl);
        await createTunnel(h.baseUrl, {
            internalHost: "127.0.0.1",
            internalPort: 1,
            edgeId: edge.id,
        });
        registerHook("delete_tunnel", (req) => req.deny());

        const res = await jsonFetch(`${h.baseUrl}/edges/${edge.id}`, { method: "DELETE" });
        assert.equal(res.status, 403);
        assert.deepEqual(res.data, { error: "Denied" });
        assert.equal((await jsonFetch(`${h.baseUrl}/edges/${edge.id}`)).status, 200);
    } finally {
        clearHooks();
        await h.close();
    }
});
