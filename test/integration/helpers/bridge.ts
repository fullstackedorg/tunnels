import net from "node:net";
import WebSocket, { createWebSocketStream } from "ws";
import { getAvailablePort } from "../../helpers.ts";

export interface TunnelBridge {
    port: number;
    close: () => Promise<void>;
}

export async function createTunnelBridge(
    hubUrl: string,
    tunnelToken: string
): Promise<TunnelBridge> {
    const port = await getAvailablePort();
    const wsUrl = hubUrl.replace(/^http:/, "ws:");
    const sockets = new Set<net.Socket>();
    const wsList = new Set<WebSocket>();

    const server = net.createServer((tcpSocket) => {
        sockets.add(tcpSocket);
        const earlyChunks: Buffer[] = [];
        let isWsReady = false;
        let wsStream: any = null;

        tcpSocket.on("data", (chunk: Buffer) => {
            if (!isWsReady) {
                earlyChunks.push(chunk);
            } else if (wsStream && !wsStream.destroyed) {
                wsStream.write(chunk);
            }
        });

        const ws = new WebSocket(wsUrl, {
            headers: { Authorization: tunnelToken },
        });
        wsList.add(ws);

        ws.once("open", () => {
            wsStream = createWebSocketStream(ws);
            isWsReady = true;

            for (const chunk of earlyChunks) {
                wsStream.write(chunk);
            }
            earlyChunks.length = 0;

            wsStream.on("data", (chunk: Buffer) => {
                tcpSocket.write(chunk);
            });

            wsStream.on("error", () => {
                tcpSocket.destroy();
            });
            tcpSocket.on("error", () => {
                wsStream.destroy();
            });
        });

        ws.once("error", () => {
            tcpSocket.destroy();
        });

        tcpSocket.once("close", () => {
            sockets.delete(tcpSocket);
            wsList.delete(ws);
            try {
                ws.close();
            } catch {}
        });

        ws.once("close", () => {
            sockets.delete(tcpSocket);
            wsList.delete(ws);
            tcpSocket.destroy();
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(port, "127.0.0.1", () => resolve());
        server.once("error", reject);
    });

    return {
        port,
        close: async () => {
            for (const s of sockets) {
                s.destroy();
            }
            sockets.clear();
            for (const ws of wsList) {
                try {
                    ws.terminate();
                } catch {}
            }
            wsList.clear();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
