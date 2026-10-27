// FullStacked P2P (fullstackedorg/p2p submodule) through tunnels: the P2P control socket is a
// long-lived TCP connection carried by a tunnel stream, from the FullStacked CLI and webview.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runProgrammatic, runInBrowser, stopFullStackedRuntime } from "./helpers/runtime.ts";
import {
    startP2PServer,
    connectP2P,
    p2pClientImport,
    until,
    P2P_CREDENTIALS,
} from "./helpers/p2p.ts";
import { jsonFetch } from "../helpers.ts";

const TMP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tmp");
const CLI_IMPORT = p2pClientImport(TMP_DIR); // runProgrammatic writes scripts in tmp/
const PAGE_IMPORT = p2pClientImport(path.join(TMP_DIR, "app")); // runInBrowser: tmp/<app>/
const { user, password } = P2P_CREDENTIALS.rw;

after(() => stopFullStackedRuntime());

async function cliOverTunnel(viaEdge: boolean) {
    const p2p = await startP2PServer();
    const harness = await setupIntegrationHarness(viaEdge);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);
    const node = await connectP2P(p2p.port, { peer: { id: "usr_node" } });
    try {
        const { token } = viaEdge
            ? await createRelayedTunnel(
                  harness.hubUrl,
                  harness.edgeId!,
                  p2p.port,
                  "127.0.0.1",
                  "P2P Relayed"
              )
            : await createDirectTunnel(harness.hubUrl, p2p.port, "127.0.0.1", "P2P Direct");
        const nodeCh = await node.subscribe("test", { create: true });
        await nodeCh.setState("seed", "from node");
        const messages: any[] = [];
        nodeCh.on("message", (e) => messages.push(e.data));
        node.on("message", (e) => e.reply?.({ transport: e.transport }));
        const cli = runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import { P2PClient } from "${CLI_IMPORT}";
            const check = (ok, message) => { if (!ok) throw new Error(message); };
            const host = await tunnel.register({ host: "127.0.0.1", port: ${hubPort}, authorization: "${token}", unsecure: true });
            const p2p = await P2PClient.connect({
                host, port: 4444, user: "${user}", password: "${password}",
                peer: { id: "usr_cli", meta: { runtime: "cli" } }, reconnect: false,
            });
            check(p2p.capabilities.webrtc === false, "the CLI is socket-only");
            check(p2p.getPeers("usr_node").length === 1, "sees the node peer");
            const ch = await p2p.subscribe("test");
            check(ch.getState("seed") === "from node", "state loaded on subscribe");
            const done = new Promise((resolve) => p2p.on("message", (e) => e.data === "done" && resolve(null)));
            p2p.on("message", (e) => e.reply?.({ pong: e.data }));
            await ch.setState("big", "x".repeat(900 * 1024)); // one frame, many tunnel chunks
            await ch.setStates({ "batch:1": 1, "batch:2": 2 }); // one state:batch frame
            for (let i = 0; i < 300; i++) await ch.broadcast({ cursor: i }, { ephemeral: true });
            await ch.broadcast({ final: true });
            const answer = await p2p.request("usr_node", "ping");
            check(answer.transport === "socket", "relayed over the control socket");
            await ch.setState("ready", true);
            await done;
            await p2p.close();
        `);
        await until(() => nodeCh.getState("ready") === true, "cli ready", 90_000);
        assert.equal((nodeCh.getState("big") as string).length, 900 * 1024);
        assert.equal(nodeCh.getState("batch:2"), 2);
        const cliPeerInfo = node.getPeers("usr_cli")[0];
        const batch = await node.peek("test", { keys: ["batch:1"] });
        assert.equal(batch.entries["batch:1"].deviceId, cliPeerInfo.deviceId, "writer's device");
        const cursors = messages.filter((m) => typeof m?.cursor === "number").map((m) => m.cursor);
        assert.ok(cursors.length > 0, "ephemeral frames arrived");
        assert.deepEqual(
            cursors,
            [...cursors].sort((a, b) => a - b),
            "byte stream order kept"
        );
        assert.ok(
            messages.some((m) => m?.final === true),
            "reliable frame after the burst"
        );
        const cliPeer = node.getPeers("usr_cli")[0];
        assert.equal(cliPeer.meta.runtime, "cli");
        assert.deepEqual(await node.request("usr_cli", "hello"), { pong: "hello" });
        await node.send("usr_cli", "done");
        await cli;
        await until(() => node.getPeers("usr_cli").length === 0, "cli left", 10_000);
    } finally {
        await node.close();
        await harness.close();
        await p2p.close();
    }
}

test("p2p: FullStacked CLI peer through a direct tunnel", { timeout: 180_000 }, () =>
    cliOverTunnel(false)
);

test("p2p: FullStacked CLI peer through an Edge-relayed tunnel", { timeout: 180_000 }, () =>
    cliOverTunnel(true)
);

test(
    "p2p: a rolled tunnel token severs the session; beforeConnect re-registers",
    { timeout: 180_000 },
    async () => {
        const p2p = await startP2PServer();
        const harness = await setupIntegrationHarness(false);
        const hubPort = parseInt(new URL(harness.hubUrl).port, 10);
        const node = await connectP2P(p2p.port, { peer: { id: "usr_node" } });
        try {
            const { tunnelId, token } = await createDirectTunnel(
                harness.hubUrl,
                p2p.port,
                "127.0.0.1",
                "P2P Roll"
            );
            const nodeCh = await node.subscribe("test", { create: true });
            const events: string[] = [];
            const sessions: string[] = [];
            const replaced: (string | undefined)[] = [];
            node.on("peer:joined", (peer, { replaces }) => {
                if (peer.peerId !== "usr_cli") return;
                events.push("joined");
                sessions.push(peer.sessionId);
                replaced.push(replaces);
            });
            node.on("peer:left", (peer) => peer.peerId === "usr_cli" && events.push("left"));
            const cli = runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import { P2PClient } from "${CLI_IMPORT}";
            const register = (authorization) =>
                tunnel.register({ host: "127.0.0.1", port: ${hubPort}, authorization, unsecure: true });
            const p2p = await P2PClient.connect({
                host: await register("${token}"), port: 4444, user: "${user}", password: "${password}",
                peer: { id: "usr_cli" },
                reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
                beforeConnect: async ({ attempt }) => {
                    if (attempt === 0) return {};
                    const res = await fetch("http://127.0.0.1:${hubPort}/tunnels/${tunnelId}");
                    const current = await res.json();
                    return { host: await register(current.token) };
                },
            });
            const ch = await p2p.subscribe("test");
            await ch.setState("before", 1);
            await new Promise((resolve) => p2p.once("reconnected", resolve));
            await ch.setState("after", 2);
            await new Promise((resolve) => p2p.on("message", (e) => e.data === "done" && resolve(null)));
            await p2p.close();
        `);
            await until(() => nodeCh.getState("before") === 1, "cli connected", 90_000);
            const rolled = await jsonFetch(`${harness.hubUrl}/tunnels/${tunnelId}/roll-token`, {
                method: "POST",
                body: {},
            });
            assert.equal(rolled.status, 200);
            assert.notEqual(rolled.data.token, token);
            await until(
                () => nodeCh.getState("after") === 2,
                "cli back with the new token",
                60_000
            );
            assert.deepEqual(events, ["joined", "left", "joined"]);
            assert.deepEqual(replaced, [undefined, sessions[0]], "the same device, back");
            await node.send("usr_cli", "done");
            await cli;
        } finally {
            await node.close();
            await harness.close();
            await p2p.close();
        }
    }
);

test("p2p: FullStacked webview page through a direct tunnel", { timeout: 180_000 }, async () => {
    const p2p = await startP2PServer();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);
    const node = await connectP2P(p2p.port, { peer: { id: "usr_node" } });
    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            p2p.port,
            "127.0.0.1",
            "P2P Page"
        );
        const nodeCh = await node.subscribe("test", { create: true });
        node.on("message", (e) => e.reply?.({ transport: e.transport }));
        const body = await runInBrowser(`
            import tunnel from "fullstacked/tunnel";
            import { P2PClient } from "${PAGE_IMPORT}";
            (async () => {
                const host = await tunnel.register({ host: "127.0.0.1", port: ${hubPort}, authorization: "${token}", unsecure: true });
                const p2p = await P2PClient.connect({
                    host, port: 4444, user: "${user}", password: "${password}", peer: { id: "usr_page" },
                });
                await (await p2p.subscribe("test")).setState("from:page", true);
                const answer = await p2p.request("usr_node", "ping");
                const result = { capabilities: p2p.capabilities, transport: answer.transport };
                await p2p.close();
                return result;
            })().then(
                (r) => { document.body.innerText = JSON.stringify(r); document.body.classList.add("done"); },
                (e) => { document.body.innerText = "Error: " + (e?.stack || e); document.body.classList.add("error"); }
            );
        `);
        const result = JSON.parse(body);
        assert.deepEqual(result.capabilities, { webrtc: true, media: true });
        assert.equal(result.transport, "socket");
        assert.equal(nodeCh.getState("from:page"), true);
    } finally {
        await node.close();
        await harness.close();
        await p2p.close();
    }
});
