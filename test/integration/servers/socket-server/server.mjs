import net from "node:net";
import { WebSocketServer } from "ws";

const TCP_PORT = parseInt(process.env.TCP_PORT || "9001", 10);
const WS_PORT = parseInt(process.env.WS_PORT || "9002", 10);

// Raw TCP Server (Port 9001)
const tcpServer = net.createServer((socket) => {
    socket.on("data", (data) => {
        const str = data.toString("utf-8");
        if (str === "PING") {
            socket.write(Buffer.from("PONG"));
            return;
        }

        // Echo with backpressure handling
        const canWriteMore = socket.write(data);
        if (!canWriteMore) {
            socket.pause();
            socket.once("drain", () => {
                socket.resume();
            });
        }
    });

    socket.on("error", (err) => {
        // Socket error handling
    });
});

tcpServer.listen(TCP_PORT, "0.0.0.0", () => {
    console.log(`TCP Socket server listening on port ${TCP_PORT}`);
});

// WebSocket Server (Port 9002)
const wss = new WebSocketServer({ port: WS_PORT });

wss.on("connection", (ws) => {
    let isAlive = true;
    ws.on("pong", () => {
        isAlive = true;
    });

    const pingInterval = setInterval(() => {
        if (!isAlive) {
            clearInterval(pingInterval);
            return ws.terminate();
        }
        isAlive = false;
        ws.ping();
    }, 15000);

    ws.on("message", (data, isBinary) => {
        const text = isBinary ? "" : data.toString("utf-8");
        if (text === "PING") {
            ws.send("PONG");
            return;
        }
        if (text === "CLOSE") {
            ws.close(1000, "client_requested");
            return;
        }

        // Echo message back with same binary flag
        ws.send(data, { binary: isBinary });
    });

    ws.on("close", () => {
        clearInterval(pingInterval);
    });

    ws.on("error", () => {
        clearInterval(pingInterval);
    });
});

console.log(`WebSocket server listening on port ${WS_PORT}`);
