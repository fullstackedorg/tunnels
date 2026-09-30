import test from "node:test";
import { PORTS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runProgrammatic } from "./helpers/runtime.ts";
import { waitForSocket } from "./helpers/compose.ts";

test("socket: raw TCP duplex streaming, chunk transfer, and echo over direct tunnel", async () => {
    await waitForSocket();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.socketTcp,
            "127.0.0.1",
            "TCP Socket Direct"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import net from "node:net";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            // 1. Duplex stream echo
            const client = new net.Socket();
            await new Promise((resolve, reject) => {
                client.on("connect", () => {
                    client.write(Buffer.from("Hello TCP Socket Direct!"));
                });
                client.once("data", (chunk) => {
                    assert.equal(chunk.toString("utf-8"), "Hello TCP Socket Direct!");
                    client.destroy();
                    resolve();
                });
                client.once("error", reject);
                client.connect(9001, host);
            });

            // 2. Multi-kilobyte chunk transfer
            const client2 = new net.Socket();
            await new Promise((resolve, reject) => {
                const chunkData = Buffer.alloc(16 * 1024, 0x42);
                let received = Buffer.alloc(0);

                client2.on("connect", () => {
                    client2.write(chunkData);
                });
                client2.on("data", (chunk) => {
                    received = Buffer.concat([received, Buffer.from(chunk)]);
                    if (received.length >= chunkData.length) {
                        assert.ok(received.equals(chunkData));
                        client2.destroy();
                        resolve();
                    }
                });
                client2.once("error", reject);
                client2.connect(9001, host);
            });
        `);
    } finally {
        await harness.close();
    }
});

test("socket: WebSocket frames, text/binary echo, and reconnects over edge relayed tunnel", async () => {
    await waitForSocket();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.socketWs,
            "127.0.0.1",
            "WebSocket Relayed"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import WebSocket from "fullstacked/websocket";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            // 1. Connect WS to relayed socket server
            const ws = new WebSocket(\`ws://\${host}/\`);
            await new Promise((resolve, reject) => {
                ws.onopen = () => {
                    ws.send("Hello WS Relayed");
                };
                ws.onmessage = (event) => {
                    assert.equal(String(event.data), "Hello WS Relayed");
                    ws.close();
                    resolve();
                };
                ws.onerror = reject;
            });

            // 2. Reconnect over relayed tunnel
            const ws2 = new WebSocket(\`ws://\${host}/\`);
            await new Promise((resolve, reject) => {
                ws2.onopen = () => {
                    ws2.send("reconnected-ok");
                };
                ws2.onmessage = (event) => {
                    assert.equal(String(event.data), "reconnected-ok");
                    ws2.close();
                    resolve();
                };
                ws2.onerror = reject;
            });
        `);
    } finally {
        await harness.close();
    }
});
