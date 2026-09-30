import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";

export async function getAvailablePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as net.AddressInfo;
            const port = addr.port;
            server.close((err) => {
                if (err) reject(err);
                else resolve(port);
            });
        });
        server.on("error", reject);
    });
}

export function createTempDir(prefix = "tunnels-test-"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return dir;
}

export function cleanupTempDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore
    }
}

export async function createTestEchoServer(): Promise<{
    server: net.Server;
    port: number;
    close: () => Promise<void>;
}> {
    const port = await getAvailablePort();
    return new Promise((resolve, reject) => {
        const sockets = new Set<net.Socket>();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            socket.pipe(socket);
        });
        server.listen(port, "127.0.0.1", () => {
            resolve({
                server,
                port,
                close: async () => {
                    for (const s of sockets) {
                        s.destroy();
                    }
                    sockets.clear();
                    return new Promise((res) => server.close(() => res()));
                },
            });
        });
        server.on("error", reject);
    });
}

export async function connectTestWs(
    url: string,
    options?: WebSocket.ClientOptions
): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, options);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });
}

export async function jsonFetch(
    url: string,
    options: {
        method?: string;
        headers?: Record<string, string>;
        body?: any;
    } = {}
): Promise<{ status: number; headers: Headers; data: any }> {
    const init: RequestInit = {
        method: options.method || "GET",
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    };
    if (options.body !== undefined) {
        init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
    const res = await fetch(url, init);
    let data: any = null;
    const text = await res.text();
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }
    return { status: res.status, headers: res.headers, data };
}
