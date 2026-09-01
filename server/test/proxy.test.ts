import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import net from "node:net";
import { setupTestServer } from "./helpers.ts";

const PORT = 3458;
await setupTestServer(PORT);

test("Tunnel proxy HTTP request e2e - https conversion (www.google.com)", async () => {
    // 1. Register proxy via HTTP API
    const proxyRes = await fetch(`http://127.0.0.1:${PORT}/proxies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-google-proxy",
            urlProtocol: "https",
            urlHost: "www.google.com",
            workerCount: 1,
        }),
    });

    assert.strictEqual(proxyRes.status, 200, "Proxy creation failed");
    const proxy = await proxyRes.json();
    assert.ok(proxy.token, "Proxy token missing");

    // 2. Make HTTP request through the tunnel server with the Authorization header
    const res = await fetch(`http://127.0.0.1:${PORT}/`, {
        headers: {
            Authorization: proxy.token,
        },
    });

    // 3. Verify assertions
    assert.strictEqual(
        res.status,
        200,
        "Proxy request to google.com should return HTTP status 200",
    );
    const bodyText = await res.text();
    assert.ok(
        bodyText.includes("google") || bodyText.includes("Google"),
        "Response body from proxy should contain google content",
    );
});

test("Tunnel proxy HTTP POST request e2e - forwards request body", async () => {
    // 1. Spawn a target HTTP server to echo request body
    const targetServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk.toString();
        });
        req.on("end", () => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    body: body,
                }),
            );
        });
    });

    await new Promise<void>((resolve) => targetServer.listen(0, resolve));
    const targetPort = (targetServer.address() as net.AddressInfo).port;

    // 2. Register proxy via HTTP API
    const proxyRes = await fetch(`http://127.0.0.1:${PORT}/proxies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-post-proxy",
            urlProtocol: "http",
            urlHost: "127.0.0.1",
            urlPort: targetPort,
            workerCount: 1,
        }),
    });

    assert.strictEqual(proxyRes.status, 200, "Proxy creation failed");
    const proxy = await proxyRes.json();
    assert.ok(proxy.token, "Proxy token missing");

    // 3. Send POST request with body through tunnel
    const payloadData = JSON.stringify(Buffer.alloc(20000, 1));
    const res = await fetch(`http://127.0.0.1:${PORT}/echo-path?param=1`, {
        method: "POST",
        headers: {
            Authorization: proxy.token,
            "Content-Type": "application/json",
        },
        body: payloadData,
    });

    assert.strictEqual(res.status, 200, "Proxy POST request failed");
    const responseJson = await res.json();

    // 4. Verify assertions
    assert.strictEqual(responseJson.method, "POST");
    assert.strictEqual(responseJson.url, "/echo-path?param=1");
    assert.strictEqual(
        responseJson.body,
        payloadData,
        "Proxied request body should match original request payload",
    );

    // Cleanup
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
});
