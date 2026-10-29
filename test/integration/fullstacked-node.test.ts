import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PORTS, CREDENTIALS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { waitForHttp, waitForSocket, waitForPostgres, waitForGit } from "./helpers/compose.ts";
import { runProgrammatic } from "./helpers/runtime.ts";

let stopFullStacked: (() => void) | null = null;

async function getFullStacked() {
    const nodeMod = (await import(
        "../../integration/fullstacked/platform/node/src/index.ts" as any
    )) as any;
    stopFullStacked = nodeMod.stop;
    const tunnelMod = (await import(
        "../../integration/fullstacked/core/internal/bundle/lib/tunnel/index.ts" as any
    )) as any;
    const fetchMod = (await import(
        "../../integration/fullstacked/core/internal/bundle/lib/fetch/index.ts" as any
    )) as any;
    const netMod = (await import(
        "../../integration/fullstacked/core/internal/bundle/lib/net/index.ts" as any
    )) as any;
    const wsMod = (await import(
        "../../integration/fullstacked/core/internal/bundle/lib/websocket/index.ts" as any
    )) as any;
    const gitMod = (await import(
        "../../integration/fullstacked/core/internal/bundle/lib/git/index.ts" as any
    )) as any;
    const pluginMod = (await import(
        "../../integration/fullstacked/core/internal/bundle/lib/plugin/index.ts" as any
    )) as any;

    return {
        tunnelGo: tunnelMod.default,
        fetchGo: fetchMod.default,
        netGo: netMod.default,
        WebSocketCore: wsMod.default || wsMod.WebSocketCore,
        gitGo: gitMod.default,
        plugin: pluginMod.default,
    };
}

after(() => {
    if (stopFullStacked) {
        stopFullStacked();
    }
});

test("fullstacked-node: programmatic direct tunnel registration and protocol fidelity", async () => {
    await waitForHttp();
    const { tunnelGo, fetchGo } = await getFullStacked();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.http,
            "127.0.0.1",
            "FS Node Direct"
        );

        // Register tunnel programmatically in FullStacked core pointing to Hub
        const registeredName = await tunnelGo.register({
            name: "fs-direct-http",
            host: "127.0.0.1",
            port: hubPort,
            authorization: token,
            unsecure: true,
        });
        assert.equal(registeredName, "fs-direct-http");

        // 1. Health check through FullStacked native Go HTTP transport
        const healthRes = await fetchGo("http://fs-direct-http/health");
        assert.equal(healthRes.status, 200);
        const healthText = await healthRes.text();
        assert.equal(healthText.trim(), "ok");

        // 2. Strict header preservation & POST body echo
        const echoPayload = JSON.stringify({ message: "Hello FullStacked Native Direct Tunnel" });
        const echoRes = await fetchGo("http://fs-direct-http/echo", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-fullstacked-protocol": "direct-v1",
            },
            body: echoPayload,
        });
        assert.equal(echoRes.status, 200);
        assert.equal(echoRes.headers.get("x-echo-x-fullstacked-protocol"), "direct-v1");
        assert.equal(echoRes.headers.get("x-response-server"), "fullstacked-http-server");
        const echoedBody = await echoRes.text();
        assert.equal(echoedBody, echoPayload);
    } finally {
        await harness.close();
    }
});

test("fullstacked-node: relayed edge tunnel registration, streaming payloads, and lifecycle management", async () => {
    await waitForHttp();
    const { tunnelGo, fetchGo } = await getFullStacked();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.http,
            "127.0.0.1",
            "FS Node Relayed"
        );

        // Register relayed tunnel programmatically in FullStacked core
        const registeredName = await tunnelGo.register({
            name: "fs-relayed-http",
            host: "127.0.0.1",
            port: hubPort,
            authorization: token,
            unsecure: true,
        });
        assert.equal(registeredName, "fs-relayed-http");

        // 1. Chunked transfer encoding over edge-relayed tunnel
        const chunkedRes = await fetchGo("http://fs-relayed-http/chunked");
        assert.equal(chunkedRes.status, 200);
        const chunkedText = await chunkedRes.text();
        assert.equal(chunkedText, "chunk-1\nchunk-2\nchunk-3\n");

        // 2. Server-Sent Events stream through edge-relayed tunnel
        const sseRes = await fetchGo("http://fs-relayed-http/sse");
        assert.equal(sseRes.status, 200);
        assert.ok(sseRes.headers.get("content-type")?.includes("text/event-stream"));
        const sseText = await sseRes.text();
        assert.ok(sseText.includes("data: sse-message-1"));
        assert.ok(sseText.includes("data: sse-message-2"));
        assert.ok(sseText.includes("data: sse-message-3"));

        // 3. Lifecycle management: re-registering and updating tunnel endpoint
        const updatedName = await tunnelGo.register({
            name: "fs-relayed-http",
            host: "127.0.0.1",
            port: hubPort,
            authorization: token,
            unsecure: true,
        });
        assert.equal(updatedName, "fs-relayed-http");

        const recheckRes = await fetchGo("http://fs-relayed-http/health");
        assert.equal(recheckRes.status, 200);
        assert.equal((await recheckRes.text()).trim(), "ok");
    } finally {
        await harness.close();
    }
});

test("fullstacked-node: raw TCP duplex streaming and concurrency via native net.Socket over direct and relayed tunnels", async () => {
    await waitForSocket();
    const { tunnelGo, netGo } = await getFullStacked();

    // 1. Direct tunnel TCP streaming
    const harnessDirect = await setupIntegrationHarness(false);
    const hubPortDirect = parseInt(new URL(harnessDirect.hubUrl).port, 10);
    try {
        const { token } = await createDirectTunnel(
            harnessDirect.hubUrl,
            PORTS.socketTcp,
            "127.0.0.1",
            "FS TCP Direct"
        );

        await tunnelGo.register({
            name: "fs-direct-tcp-echo",
            host: "127.0.0.1",
            port: hubPortDirect,
            authorization: token,
            unsecure: true,
        });

        const socket = new netGo.Socket();
        let received = Buffer.alloc(0);
        const testPayload = Buffer.from("FullStacked TCP Direct Streaming Test\n");

        await new Promise<void>((resolve, reject) => {
            socket.on("connect", () => {
                socket.write(testPayload);
            });
            socket.on("data", (chunk: Uint8Array) => {
                received = Buffer.concat([received, Buffer.from(chunk)]);
                if (received.length >= testPayload.length) {
                    socket.destroy();
                }
            });
            socket.on("close", resolve);
            socket.on("error", reject);
            socket.connect(PORTS.socketTcp, "fs-direct-tcp-echo");
        });

        assert.deepEqual(received, testPayload);
    } finally {
        await harnessDirect.close();
    }

    // 2. Relayed tunnel TCP streaming with multiple concurrent sockets
    const harnessRelayed = await setupIntegrationHarness(true);
    const hubPortRelayed = parseInt(new URL(harnessRelayed.hubUrl).port, 10);
    try {
        const { token } = await createRelayedTunnel(
            harnessRelayed.hubUrl,
            harnessRelayed.edgeId!,
            PORTS.socketTcp,
            "127.0.0.1",
            "FS TCP Relayed"
        );

        await tunnelGo.register({
            name: "fs-relayed-tcp-echo",
            host: "127.0.0.1",
            port: hubPortRelayed,
            authorization: token,
            unsecure: true,
        });

        const concurrency = 4;
        const promises = Array.from({ length: concurrency }).map((_, i) => {
            const socket = new netGo.Socket();
            let rec = Buffer.alloc(0);
            const payload = Buffer.from(`Relayed Stream Chunk #${i} - ${Date.now()}\n`);

            return new Promise<void>((resolve, reject) => {
                socket.on("connect", () => {
                    socket.write(payload);
                });
                socket.on("data", (chunk: Uint8Array) => {
                    rec = Buffer.concat([rec, Buffer.from(chunk)]);
                    if (rec.length >= payload.length) {
                        socket.destroy();
                    }
                });
                socket.on("close", () => {
                    assert.deepEqual(rec, payload);
                    resolve();
                });
                socket.on("error", reject);
                socket.connect(PORTS.socketTcp, "fs-relayed-tcp-echo");
            });
        });

        await Promise.all(promises);
    } finally {
        await harnessRelayed.close();
    }
});

test("fullstacked-node: PostgreSQL client pooling, DDL, and transactions over net.Socket tunnel", async () => {
    await waitForPostgres();
    const { tunnelGo, netGo } = await getFullStacked();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.postgres,
            "127.0.0.1",
            "FS PG Relayed"
        );

        await tunnelGo.register({
            name: "fs-pg-tunnel",
            host: "127.0.0.1",
            port: hubPort,
            authorization: token,
            unsecure: true,
        });

        const pool = new pg.Pool({
            host: "fs-pg-tunnel",
            port: PORTS.postgres,
            user: CREDENTIALS.postgres.user,
            password: CREDENTIALS.postgres.password,
            database: CREDENTIALS.postgres.database,
            stream: () => new netGo.Socket(),
        });

        // 1. Basic query
        const basicRes = await pool.query("SELECT 42 * 2 AS result");
        assert.equal(basicRes.rows[0].result, 84);

        // 2. DDL, DML and Transaction isolation test
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                "CREATE TEMP TABLE fs_test_items (id SERIAL PRIMARY KEY, name VARCHAR(50), score INT)"
            );
            await client.query(
                "INSERT INTO fs_test_items (name, score) VALUES ('alpha', 10), ('beta', 20), ('gamma', 30)"
            );
            const sumRes = await client.query("SELECT SUM(score) as total FROM fs_test_items");
            assert.equal(parseInt(sumRes.rows[0].total, 10), 60);
            await client.query("COMMIT");
        } finally {
            client.release();
        }

        await pool.end();
    } finally {
        await harness.close();
    }
});

test("fullstacked-node: native WebSocket streaming over direct and relayed tunnels", async () => {
    await waitForSocket();
    const { tunnelGo, WebSocketCore } = await getFullStacked();

    // 1. Direct WebSocket
    const harnessDirect = await setupIntegrationHarness(false);
    const hubPortDirect = parseInt(new URL(harnessDirect.hubUrl).port, 10);
    try {
        const { token } = await createDirectTunnel(
            harnessDirect.hubUrl,
            PORTS.socketWs,
            "127.0.0.1",
            "FS WS Direct"
        );

        await tunnelGo.register({
            name: "fs-direct-ws",
            host: "127.0.0.1",
            port: hubPortDirect,
            authorization: token,
            unsecure: true,
        });

        const ws = new WebSocketCore("ws://fs-direct-ws/");
        const received = await new Promise((resolve, reject) => {
            ws.onopen = () => {
                ws.send("Hello Direct WS Native");
            };
            ws.onmessage = (event: any) => {
                resolve(event.data);
                ws.close();
            };
            ws.onerror = (err: any) => reject(err);
        });

        assert.equal(received, "Hello Direct WS Native");
    } finally {
        await harnessDirect.close();
    }

    // 2. Relayed WebSocket
    const harnessRelayed = await setupIntegrationHarness(true);
    const hubPortRelayed = parseInt(new URL(harnessRelayed.hubUrl).port, 10);
    try {
        const { token } = await createRelayedTunnel(
            harnessRelayed.hubUrl,
            harnessRelayed.edgeId!,
            PORTS.socketWs,
            "127.0.0.1",
            "FS WS Relayed"
        );

        await tunnelGo.register({
            name: "fs-relayed-ws",
            host: "127.0.0.1",
            port: hubPortRelayed,
            authorization: token,
            unsecure: true,
        });

        const ws = new WebSocketCore("ws://fs-relayed-ws/");
        const received = await new Promise((resolve, reject) => {
            ws.onopen = () => {
                ws.send("Hello Relayed WS Native");
            };
            ws.onmessage = (event: any) => {
                resolve(event.data);
                ws.close();
            };
            ws.onerror = (err: any) => reject(err);
        });

        assert.equal(received, "Hello Relayed WS Native");
    } finally {
        await harnessRelayed.close();
    }
});

test("fullstacked-node: native git clone and log inspection over direct and relayed tunnels", async () => {
    await waitForGit();
    const { tunnelGo, gitGo, plugin } = await getFullStacked();

    await plugin.register("git-auth", {
        callback: () => ({
            username: CREDENTIALS.git.username,
            password: CREDENTIALS.git.password,
        }),
    });

    // 1. Direct tunnel git clone
    const harnessDirect = await setupIntegrationHarness(false);
    const hubPortDirect = parseInt(new URL(harnessDirect.hubUrl).port, 10);
    const targetDirDirect = `test/integration/tmp/git-fs-direct-${Date.now()}`;

    try {
        const { token } = await createDirectTunnel(
            harnessDirect.hubUrl,
            PORTS.git,
            "127.0.0.1",
            "FS Git Direct"
        );

        await tunnelGo.register({
            name: "fs-git-direct",
            host: "127.0.0.1",
            port: hubPortDirect,
            authorization: token,
            unsecure: true,
        });

        const duplex = await gitGo.clone("http://localhost/test.git", targetDirDirect, {
            tunnel: "fs-git-direct",
        });
        await duplex.promise();

        assert.ok(fs.existsSync(path.join(targetDirDirect, "test.txt")));
        assert.equal(
            fs.readFileSync(path.join(targetDirDirect, "test.txt"), "utf-8").trim(),
            "test file"
        );

        const commits = await gitGo.log(targetDirDirect);
        assert.ok(commits.length > 0);
    } finally {
        try {
            fs.rmSync(targetDirDirect, { recursive: true, force: true });
        } catch {}
        await harnessDirect.close();
    }

    // 2. Relayed tunnel git clone
    const harnessRelayed = await setupIntegrationHarness(true);
    const hubPortRelayed = parseInt(new URL(harnessRelayed.hubUrl).port, 10);
    const targetDirRelayed = `test/integration/tmp/git-fs-relayed-${Date.now()}`;

    try {
        const { token } = await createRelayedTunnel(
            harnessRelayed.hubUrl,
            harnessRelayed.edgeId!,
            PORTS.git,
            "127.0.0.1",
            "FS Git Relayed"
        );

        await tunnelGo.register({
            name: "fs-git-relayed",
            host: "127.0.0.1",
            port: hubPortRelayed,
            authorization: token,
            unsecure: true,
        });

        const duplex = await gitGo.clone("http://localhost/test.git", targetDirRelayed, {
            tunnel: "fs-git-relayed",
        });
        await duplex.promise();

        assert.ok(fs.existsSync(path.join(targetDirRelayed, "test.txt")));
        assert.equal(
            fs.readFileSync(path.join(targetDirRelayed, "test.txt"), "utf-8").trim(),
            "test file"
        );
    } finally {
        try {
            fs.rmSync(targetDirRelayed, { recursive: true, force: true });
        } catch {}
        await harnessRelayed.close();
    }
});

test("fullstacked-node: programmatic CLI execution of scripts interacting with tunnel-registered services", async () => {
    await waitForPostgres();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.postgres,
            "127.0.0.1",
            "FS Programmatic PG"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import net from "node:net";
            import pg from "pg";

            async function main() {
                const host = await tunnel.register({
                    host: "127.0.0.1",
                    port: ${hubPort},
                    authorization: "${token}",
                    unsecure: true,
                });

                const pool = new pg.Pool({
                    host,
                    port: ${PORTS.postgres},
                    user: "postgres",
                    password: "secret",
                    database: "postgres",
                    stream: () => new net.Socket(),
                });

                const res = await pool.query("SELECT 500 + 555 AS sum");
                if (res.rows[0].sum !== 1055) {
                    throw new Error("Unexpected sum: " + res.rows[0].sum);
                }
                await pool.end();
            }

            await main();
        `);
    } finally {
        await harness.close();
    }
});
