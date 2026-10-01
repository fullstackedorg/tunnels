import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";
import type { KVProvider } from "../src/kv/interface.ts";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";

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

export function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) {
            resolve({ code: 1006, reason: "" });
            return;
        }
        ws.once("close", (code, reasonBuf) => {
            resolve({ code, reason: reasonBuf.toString("utf-8") });
        });
    });
}

export async function waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
    intervalMs = 20
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await condition()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Wraps a KVProvider to record writes and inject failures on selected keys. */
export class SpyKV implements KVProvider {
    inner: KVProvider;
    sets: Array<{ key: string; value: any; ttl?: number }> = [];
    failKey: (key: string) => boolean = () => false;

    constructor(inner: KVProvider) {
        this.inner = inner;
    }

    private check(key: string): void {
        if (this.failKey(key)) {
            const err: any = new Error("KV unavailable");
            err.code = "ECONNREFUSED";
            throw err;
        }
    }

    async get<T = any>(key: string): Promise<T | null> {
        this.check(key);
        return this.inner.get<T>(key);
    }
    async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
        this.check(key);
        this.sets.push({ key, value, ttl: ttlSeconds });
        return this.inner.set(key, value, ttlSeconds);
    }
    async setNX(key: string, value: any, ttlSeconds: number): Promise<boolean> {
        this.check(key);
        return this.inner.setNX(key, value, ttlSeconds);
    }
    async del(keys: string | string[]): Promise<void> {
        return this.inner.del(keys);
    }
    async getdel<T = any>(key: string): Promise<T | null> {
        this.check(key);
        return this.inner.getdel<T>(key);
    }
    async delIfEquals(key: string, expected: any): Promise<boolean> {
        return this.inner.delIfEquals(key, expected);
    }
    async sadd(key: string, member: string): Promise<void> {
        return this.inner.sadd(key, member);
    }
    async srem(key: string, member: string): Promise<void> {
        return this.inner.srem(key, member);
    }
    async smembers(key: string): Promise<string[]> {
        return this.inner.smembers(key);
    }
    async close(): Promise<void> {
        return this.inner.close();
    }
}

/** Opens a raw lifeline (acting as an Edge) and records every order it receives. */
export async function connectRawLifeline(
    hubPort: number,
    edgeToken: string,
    options: WebSocket.ClientOptions = {}
): Promise<{ ws: WebSocket; orders: any[] }> {
    const ws = await connectTestWs(`ws://127.0.0.1:${hubPort}/`, {
        ...options,
        headers: { Authorization: edgeToken, ...(options.headers || {}) },
    });
    const orders: any[] = [];
    ws.on("message", (data: Buffer) => {
        orders.push(JSON.parse(data.toString("utf-8")));
    });
    return { ws, orders };
}

export interface TestHub {
    hub: HubInstance;
    port: number;
    baseUrl: string;
    dir: string;
    close: () => Promise<number>;
}

/** Starts an in-process single-worker Hub on a free port with its own data dir. */
export async function startTestHub(extraArgs: string[] = []): Promise<TestHub> {
    const port = await getAvailablePort();
    const dir = createTempDir("hub-");
    const hub = await startHub(
        parseConfig(["--port", String(port), "--data-dir", dir, ...extraArgs])
    );
    let closed = false;
    return {
        hub,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        dir,
        close: async () => {
            if (closed) return 0;
            closed = true;
            const code = await hub.close();
            cleanupTempDir(dir);
            return code;
        },
    };
}

export async function createTunnel(baseUrl: string, body: Record<string, any>): Promise<any> {
    const res = await jsonFetch(`${baseUrl}/tunnels`, {
        method: "POST",
        body: { name: "test-tunnel", ...body },
    });
    if (res.status !== 201) throw new Error(`createTunnel failed: ${res.status}`);
    return res.data;
}

export async function createEdge(baseUrl: string, name = "test-edge"): Promise<any> {
    const res = await jsonFetch(`${baseUrl}/edges`, { method: "POST", body: { name } });
    if (res.status !== 201) throw new Error(`createEdge failed: ${res.status}`);
    return res.data;
}
