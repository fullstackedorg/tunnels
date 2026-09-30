import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PORTS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runInBrowser, stopFullStackedRuntime } from "./helpers/runtime.ts";
import { waitForHttp, waitForSocket } from "./helpers/compose.ts";

after(() => {
    stopFullStackedRuntime();
});

test("browser: in-browser HTTP fetch through direct tunnel", async () => {
    await waitForHttp();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.http,
            "127.0.0.1",
            "Browser Direct HTTP"
        );

        const body = await runInBrowser(`
            import tunnel from "fullstacked/tunnel";

            async function run() {
                try {
                    const host = await tunnel.register({
                        host: "127.0.0.1",
                        port: ${hubPort},
                        authorization: "${token}",
                        unsecure: true,
                    });

                    const resp = await fetch(\`http://\${host}/echo\`, {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "x-browser-test": "browser-client-v1",
                        },
                        body: JSON.stringify({ message: "Hello from Headless Browser" }),
                    });
                    const data = await resp.json();
                    const echoHeader = resp.headers.get("x-echo-x-browser-test");

                    document.body.innerText = JSON.stringify({
                        status: resp.status,
                        message: data.message,
                        echoHeader,
                    });
                    document.body.classList.add("done");
                } catch (err) {
                    document.body.innerText = "Error: " + String(err);
                    document.body.classList.add("error");
                }
            }

            run();
        `);

        const result = JSON.parse(body);
        assert.equal(result.status, 200);
        assert.equal(result.message, "Hello from Headless Browser");
        assert.equal(result.echoHeader, "browser-client-v1");
    } finally {
        await harness.close();
    }
});

test("browser: in-browser HTTP POST and headers through edge relayed tunnel", async () => {
    await waitForHttp();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.http,
            "127.0.0.1",
            "Browser Relayed HTTP"
        );

        const body = await runInBrowser(`
            import tunnel from "fullstacked/tunnel";

            async function run() {
                try {
                    const host = await tunnel.register({
                        host: "127.0.0.1",
                        port: ${hubPort},
                        authorization: "${token}",
                        unsecure: true,
                    });

                    const resp = await fetch(\`http://\${host}/echo\`, {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "x-browser-relayed": "relayed-ok",
                        },
                        body: JSON.stringify({ message: "Hello from Relayed Browser" }),
                    });
                    const data = await resp.json();
                    const echoHeader = resp.headers.get("x-echo-x-browser-relayed");

                    document.body.innerText = JSON.stringify({
                        status: resp.status,
                        message: data.message,
                        echoHeader,
                    });
                    document.body.classList.add("done");
                } catch (err) {
                    document.body.innerText = "Error: " + String(err);
                    document.body.classList.add("error");
                }
            }

            run();
        `);

        const result = JSON.parse(body);
        assert.equal(result.status, 200);
        assert.equal(result.message, "Hello from Relayed Browser");
        assert.equal(result.echoHeader, "relayed-ok");
    } finally {
        await harness.close();
    }
});

test("browser: in-browser WebSocket streaming through direct tunnel with custom name option", async () => {
    await waitForSocket();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.socketWs,
            "127.0.0.1",
            "Browser Direct WS"
        );

        const body = await runInBrowser(`
            import tunnel from "fullstacked/tunnel";

            window.addEventListener("error", (e) => {
                document.body.innerText = "Window Error: " + (e.error?.message || e.message);
                document.body.classList.add("error");
            });
            window.addEventListener("unhandledrejection", (e) => {
                document.body.innerText = "Unhandled Rejection: " + String(e.reason);
                document.body.classList.add("error");
            });

            async function run() {
                try {
                    const customName = "browser-direct-ws-" + Date.now();
                    const tunnelName = await tunnel.register({
                        name: customName,
                        host: "127.0.0.1",
                        port: ${hubPort},
                        authorization: "${token}",
                        unsecure: true,
                    });

                    if (tunnelName !== customName) {
                        throw new Error(\`Expected tunnelName to be \${customName}, got \${tunnelName}\`);
                    }

                    // In FullStacked runtime, window.WebSocket is overridden by WebSocketCore
                    const tunneledWS = new window.WebSocket("ws://" + tunnelName);
                    tunneledWS.onopen = () => {
                        tunneledWS.send("Hello Direct Browser WS Echo");
                    };
                    tunneledWS.onmessage = (event) => {
                        document.body.innerText = String(event.data);
                        document.body.classList.add("done");
                        tunneledWS.close();
                    };
                    tunneledWS.onerror = (err) => {
                        document.body.innerText = "WS Error: " + String(err);
                        document.body.classList.add("error");
                    };
                } catch (err) {
                    document.body.innerText = "Error: " + String(err);
                    document.body.classList.add("error");
                }
            }

            run();
        `);

        assert.equal(body, "Hello Direct Browser WS Echo");
    } finally {
        await harness.close();
    }
});

test("browser: in-browser WebSocket streaming through edge relayed tunnel with generated virtual host", async () => {
    await waitForSocket();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.socketWs,
            "127.0.0.1",
            "Browser Relayed WS"
        );

        const body = await runInBrowser(`
            import tunnel from "fullstacked/tunnel";

            window.addEventListener("error", (e) => {
                document.body.innerText = "Window Error: " + (e.error?.message || e.message);
                document.body.classList.add("error");
            });
            window.addEventListener("unhandledrejection", (e) => {
                document.body.innerText = "Unhandled Rejection: " + String(e.reason);
                document.body.classList.add("error");
            });

            async function run() {
                try {
                    // Omitting name option causes tunnel.register to return a generated virtual host name
                    const tunnelName = await tunnel.register({
                        host: "127.0.0.1",
                        port: ${hubPort},
                        authorization: "${token}",
                        unsecure: true,
                    });

                    if (!tunnelName || typeof tunnelName !== "string") {
                        throw new Error("Expected generated tunnelName string from tunnel.register");
                    }

                    // In FullStacked runtime, window.WebSocket routes through the registered tunnel
                    const tunneledWS = new window.WebSocket("ws://" + tunnelName);
                    tunneledWS.onopen = () => {
                        tunneledWS.send("Hello Browser WS Echo");
                    };
                    tunneledWS.onmessage = (event) => {
                        document.body.innerText = String(event.data);
                        document.body.classList.add("done");
                        tunneledWS.close();
                    };
                    tunneledWS.onerror = (err) => {
                        document.body.innerText = "WS Error: " + String(err);
                        document.body.classList.add("error");
                    };
                } catch (err) {
                    document.body.innerText = "Error: " + String(err);
                    document.body.classList.add("error");
                }
            }

            run();
        `);

        assert.equal(body, "Hello Browser WS Echo");
    } finally {
        await harness.close();
    }
});

test("browser: native browser window.WebSocket without FullStacked runtime is denied due to missing Authorization header", async () => {
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        await createDirectTunnel(
            harness.hubUrl,
            PORTS.socketWs,
            "127.0.0.1",
            "Direct WS Spec Check"
        );

        const body = await runInBrowser(`
            async function run() {
                // Native browser WebSocket cannot supply custom headers (e.g. Authorization)
                // per W3C specification, and must fail against Hub with handshake error
                const ws = new window.WebSocket("ws://127.0.0.1:${hubPort}/");
                ws.onopen = () => {
                    document.body.innerText = "UNEXPECTED_OPEN";
                    document.body.classList.add("done");
                };
                ws.onerror = () => {
                    document.body.innerText = "NATIVE_WS_DENIED_AS_SPECIFIED";
                    document.body.classList.add("done");
                };
            }

            run();
        `);

        assert.equal(body, "NATIVE_WS_DENIED_AS_SPECIFIED");
    } finally {
        await harness.close();
    }
});
