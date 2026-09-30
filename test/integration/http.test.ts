import test from "node:test";
import { PORTS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runProgrammatic } from "./helpers/runtime.ts";
import { waitForHttp } from "./helpers/compose.ts";

test("http: HTTP/1.1, chunked encoding, SSE, and header preservation over direct tunnel", async () => {
    await waitForHttp();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.http,
            "127.0.0.1",
            "HTTP Direct"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });
            const baseUrl = \`http://\${host}\`;

            // 1. Health check
            const healthRes = await fetch(\`\${baseUrl}/health\`);
            assert.equal(healthRes.status, 200);
            assert.equal((await healthRes.text()).trim(), "ok");

            // 2. Header preservation & echo
            const echoPayload = JSON.stringify({ message: "Hello Direct HTTP Tunnel" });
            const echoRes = await fetch(\`\${baseUrl}/echo\`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-client-custom-header": "test-direct-val",
                },
                body: echoPayload,
            });
            assert.equal(echoRes.status, 200);
            assert.equal(echoRes.headers.get("x-echo-x-client-custom-header"), "test-direct-val");
            assert.equal(echoRes.headers.get("x-response-server"), "fullstacked-http-server");
            assert.equal(await echoRes.text(), echoPayload);

            // 3. Chunked transfer encoding
            const chunkedRes = await fetch(\`\${baseUrl}/chunked\`);
            assert.equal(chunkedRes.status, 200);
            const chunkedText = await chunkedRes.text();
            assert.equal(chunkedText, "chunk-1\\nchunk-2\\nchunk-3\\n");

            // 4. Server-Sent Events (SSE)
            const sseRes = await fetch(\`\${baseUrl}/sse\`);
            assert.equal(sseRes.status, 200);
            assert.ok(sseRes.headers.get("content-type")?.includes("text/event-stream"));
            const sseText = await sseRes.text();
            assert.ok(sseText.includes("data: sse-message-1"));
            assert.ok(sseText.includes("data: sse-message-2"));
            assert.ok(sseText.includes("data: sse-message-3"));

            // 5. Streaming payload
            const streamPayload = "binary-stream-chunk-payload-12345";
            const streamRes = await fetch(\`\${baseUrl}/stream\`, {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: streamPayload,
            });
            assert.equal(streamRes.status, 200);
            assert.equal(await streamRes.text(), streamPayload);
        `);
    } finally {
        await harness.close();
    }
});

test("http: HTTP/1.1 and streaming over edge relayed tunnel", async () => {
    await waitForHttp();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.http,
            "127.0.0.1",
            "HTTP Relayed"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });
            const baseUrl = \`http://\${host}\`;

            // 1. HTTP/1.1 over relayed
            const res = await fetch(\`\${baseUrl}/health\`);
            assert.equal(res.status, 200);
            assert.equal((await res.text()).trim(), "ok");

            // 2. Echo with headers
            const echoRes = await fetch(\`\${baseUrl}/echo\`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-h2-test": "relayed-h2",
                },
                body: "h2-relayed-payload",
            });
            assert.equal(echoRes.status, 200);
            assert.equal(echoRes.headers.get("x-echo-x-h2-test"), "relayed-h2");
            assert.equal(await echoRes.text(), "h2-relayed-payload");

            // 3. Chunked over relayed
            const chunkedRes = await fetch(\`\${baseUrl}/chunked\`);
            assert.equal(chunkedRes.status, 200);
            assert.equal(await chunkedRes.text(), "chunk-1\\nchunk-2\\nchunk-3\\n");

            // 4. SSE over relayed
            const sseRes = await fetch(\`\${baseUrl}/sse\`);
            assert.equal(sseRes.status, 200);
            const sseText = await sseRes.text();
            assert.ok(sseText.includes("data: sse-message-1"));
        `);
    } finally {
        await harness.close();
    }
});
