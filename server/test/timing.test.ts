import test from "node:test";
import assert from "node:assert";
import net from "node:net";
import * as ws from "ws";
import { setupTestServer } from "./helpers";

const PORT = 3457;
await setupTestServer(PORT);

test("Tunnel service timing - rapid back-to-back client writes on open", async () => {
    let receivedChunks: string[] = [];
    const socketServer = net.createServer((socket) => {
        socket.on("data", (data) => {
            receivedChunks.push(data.toString());
        });
    });

    await new Promise<void>((resolve) => socketServer.listen(0, resolve));
    const socketPort = (socketServer.address() as net.AddressInfo).port;

    const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-timing-rapid-client",
            internalHost: "127.0.0.1",
            internalPort: socketPort,
            workerCount: 1,
        }),
    });

    const service = await serviceRes.json();

    const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: { Authorization: service.token },
    });

    await new Promise<void>((resolve, reject) => {
        wsClient.on("open", resolve);
        wsClient.on("error", reject);
    });

    // Send 10 rapid messages immediately on open
    const messages = Array.from({ length: 10 }, (_, i) => `MSG_${i}_DATA;`);
    for (const msg of messages) {
        wsClient.send(msg);
    }

    const expectedFull = messages.join("");

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () =>
                reject(
                    new Error(
                        `Timed out waiting for rapid chunks. Received: ${receivedChunks.join("")}`,
                    ),
                ),
            5000,
        );
        const interval = setInterval(() => {
            if (receivedChunks.join("") === expectedFull) {
                clearInterval(interval);
                clearTimeout(timeout);
                resolve();
            }
        }, 20);
    });

    assert.strictEqual(
        receivedChunks.join(""),
        expectedFull,
        "All rapid client messages must be delivered to outbound socket",
    );

    wsClient.close();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
});

test("Tunnel service timing - external service instant write on connection", async () => {
    const greetingMessage = "BANNER: WELCOME_TO_EXTERNAL_SERVICE\n";

    const socketServer = net.createServer((socket) => {
        // Instantly write to socket as soon as tunnel worker connects
        socket.write(greetingMessage);

        socket.on("data", (data) => {
            // Echo back anything client sends after banner
            socket.write(data);
        });
    });

    await new Promise<void>((resolve) => socketServer.listen(0, resolve));
    const socketPort = (socketServer.address() as net.AddressInfo).port;

    const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-timing-instant-banner",
            internalHost: "127.0.0.1",
            internalPort: socketPort,
            workerCount: 1,
        }),
    });

    const service = await serviceRes.json();

    const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: { Authorization: service.token },
    });

    const greetingPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for instant banner")),
            5000,
        );
        wsClient.on("message", (data) => {
            clearTimeout(timeout);
            resolve(data.toString());
        });
        wsClient.on("error", reject);
    });

    const receivedGreeting = await greetingPromise;
    assert.strictEqual(
        receivedGreeting,
        greetingMessage,
        "Tunnel must deliver external service instant write to outbound conn",
    );

    // Client responds back to the server
    const clientResponsePromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for echo reply")),
            5000,
        );
        wsClient.on("message", (data) => {
            clearTimeout(timeout);
            resolve(data.toString());
        });
        wsClient.on("error", reject);
    });

    wsClient.send("CLIENT_ACK");
    const echoReply = await clientResponsePromise;
    assert.strictEqual(
        echoReply,
        "CLIENT_ACK",
        "Tunnel must deliver client ACK back to external service socket",
    );

    wsClient.close();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
});

test("Tunnel service timing - simultaneous instant writes on connect", async () => {
    const serverInstantMsg = "SERVER_INSTANT_PING";
    const clientInstantMsg = "CLIENT_INSTANT_PONG";

    let serverReceivedClientMsg = "";

    const socketServer = net.createServer((socket) => {
        // Instantly write to client
        socket.write(serverInstantMsg);

        socket.on("data", (data) => {
            serverReceivedClientMsg += data.toString();
        });
    });

    await new Promise<void>((resolve) => socketServer.listen(0, resolve));
    const socketPort = (socketServer.address() as net.AddressInfo).port;

    const serviceRes = await fetch(`http://127.0.0.1:${PORT}/services`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-timing-simultaneous",
            internalHost: "127.0.0.1",
            internalPort: socketPort,
            workerCount: 1,
        }),
    });

    const service = await serviceRes.json();

    const wsClient = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
        headers: { Authorization: service.token },
    });

    let clientReceivedServerMsg = "";
    const clientGotServerPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () => reject(new Error("Timed out waiting for server instant msg")),
            5000,
        );
        wsClient.on("message", (data) => {
            clientReceivedServerMsg += data.toString();
            if (clientReceivedServerMsg.includes(serverInstantMsg)) {
                clearTimeout(timeout);
                resolve();
            }
        });
    });

    // Send immediately on open
    wsClient.on("open", () => {
        wsClient.send(clientInstantMsg);
    });

    await clientGotServerPromise;
    assert.strictEqual(
        clientReceivedServerMsg,
        serverInstantMsg,
        "Client must receive server instant write",
    );

    // Wait until server receives client message
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
            () =>
                reject(
                    new Error(
                        "Timed out waiting for server to receive client instant msg",
                    ),
                ),
            5000,
        );
        const interval = setInterval(() => {
            if (serverReceivedClientMsg.includes(clientInstantMsg)) {
                clearInterval(interval);
                clearTimeout(timeout);
                resolve();
            }
        }, 20);
    });

    assert.strictEqual(
        serverReceivedClientMsg,
        clientInstantMsg,
        "External server must receive client instant write",
    );

    wsClient.close();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
});
