import net from "node:net";
import WebSocket from "ws";
import { MuxSession } from "../../../src/mux/session.ts";
import { getAvailablePort } from "../../helpers.ts";

export interface TunnelBridge {
    port: number;
    close: () => Promise<void>;
}

/** A local TCP listener whose connections are streams of one tunnel session (re-dialed once closed). */
export async function createTunnelBridge(
    hubUrl: string,
    tunnelToken: string
): Promise<TunnelBridge> {
    const port = await getAvailablePort();
    const wsUrl = hubUrl.replace(/^http:/, "ws:");
    const sockets = new Set<net.Socket>();
    let session: Promise<MuxSession> | null = null;

    const dial = () =>
        new Promise<MuxSession>((resolve, reject) => {
            const ws = new WebSocket(wsUrl, {
                headers: { Authorization: tunnelToken },
                perMessageDeflate: false,
            });
            ws.once("open", () => resolve(new MuxSession(ws)));
            ws.once("error", reject);
        });

    const server = net.createServer(async (tcpSocket) => {
        sockets.add(tcpSocket);
        tcpSocket.once("close", () => sockets.delete(tcpSocket));
        tcpSocket.on("error", () => {});
        tcpSocket.pause();
        try {
            if (!session || !(await session).open) session = dial();
            const { stream } = (await session).startStream();
            stream.on("error", () => tcpSocket.destroy());
            tcpSocket.on("error", () => stream.destroy());
            stream.once("close", () => tcpSocket.destroy());
            tcpSocket.pipe(stream).pipe(tcpSocket);
            tcpSocket.resume();
        } catch {
            session = null;
            tcpSocket.destroy();
        }
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
            const open = await session?.catch(() => null);
            open?.ws.terminate();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
