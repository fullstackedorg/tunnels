import net from "node:net";
import pg from "pg";
import { createClient } from "redis";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import WebSocket from "ws";
import { PORTS, CREDENTIALS } from "./env.ts";

async function pollReady(
    name: string,
    checkFn: () => Promise<boolean>,
    timeoutMs = 60000,
    intervalMs = 1000
): Promise<void> {
    const start = Date.now();
    let lastError: any = null;
    while (Date.now() - start < timeoutMs) {
        try {
            if (await checkFn()) {
                return;
            }
        } catch (err) {
            lastError = err;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
        `Service ${name} failed to become ready within ${timeoutMs}ms. Last: ${lastError?.message}`
    );
}

export async function waitForPostgres(timeoutMs = 60000): Promise<void> {
    await pollReady(
        "PostgreSQL",
        async () => {
            const client = new pg.Client({
                host: "127.0.0.1",
                port: PORTS.postgres,
                user: CREDENTIALS.postgres.user,
                password: CREDENTIALS.postgres.password,
                database: CREDENTIALS.postgres.database,
                connectionTimeoutMillis: 2000,
            });
            try {
                await client.connect();
                const res = await client.query("SELECT 1 AS ok");
                await client.end();
                return res.rows[0]?.ok === 1;
            } catch {
                try {
                    await client.end();
                } catch {}
                return false;
            }
        },
        timeoutMs
    );
}

export async function waitForRedis(timeoutMs = 60000): Promise<void> {
    await pollReady(
        "Redis",
        async () => {
            const client = createClient({
                url: `redis://:${CREDENTIALS.redis.password}@127.0.0.1:${PORTS.redis}`,
                socket: { connectTimeout: 2000 },
            });
            client.on("error", () => {});
            try {
                await client.connect();
                const pong = await client.ping();
                await client.disconnect();
                return pong === "PONG";
            } catch {
                try {
                    await client.disconnect();
                } catch {}
                return false;
            }
        },
        timeoutMs
    );
}

export async function waitForMySQL(timeoutMs = 60000): Promise<void> {
    await pollReady(
        "MySQL",
        async () => {
            try {
                const conn = await mysql.createConnection({
                    host: "127.0.0.1",
                    port: PORTS.mysql,
                    user: CREDENTIALS.mysql.user,
                    password: CREDENTIALS.mysql.password,
                    database: CREDENTIALS.mysql.database,
                    connectTimeout: 2000,
                });
                const [rows] = (await conn.query("SELECT 1 AS ok")) as any;
                await conn.end();
                return rows[0]?.ok === 1;
            } catch {
                return false;
            }
        },
        timeoutMs
    );
}

export async function waitForMongo(timeoutMs = 60000): Promise<void> {
    await pollReady(
        "MongoDB",
        async () => {
            const url = `mongodb://${CREDENTIALS.mongo.username}:${CREDENTIALS.mongo.password}@127.0.0.1:${PORTS.mongo}/admin`;
            const client = new MongoClient(url, { serverSelectionTimeoutMS: 2000 });
            try {
                await client.connect();
                const ping = await client.db("admin").command({ ping: 1 });
                await client.close();
                return ping.ok === 1;
            } catch {
                try {
                    await client.close();
                } catch {}
                return false;
            }
        },
        timeoutMs
    );
}

export async function waitForRustFS(timeoutMs = 60000): Promise<void> {
    await pollReady(
        "RustFS",
        async () => {
            try {
                const res = await fetch(`http://127.0.0.1:${PORTS.s3}/`);
                return res.status === 200 || res.status === 403 || res.status === 404;
            } catch {
                return false;
            }
        },
        timeoutMs
    );
}

export async function waitForHttp(timeoutMs = 60000): Promise<void> {
    await pollReady(
        "HTTP Server",
        async () => {
            try {
                const res = await fetch(`http://127.0.0.1:${PORTS.http}/health`);
                const text = await res.text();
                return res.status === 200 && text.trim() === "ok";
            } catch {
                return false;
            }
        },
        timeoutMs
    );
}

export async function waitForSocket(timeoutMs = 60000): Promise<void> {
    await pollReady(
        "Socket Server (TCP & WS)",
        async () => {
            // Check TCP 9001
            const tcpOk = await new Promise<boolean>((resolve) => {
                const s = net.createConnection({ host: "127.0.0.1", port: PORTS.socketTcp });
                s.setTimeout(1500);
                s.once("connect", () => {
                    s.end();
                    resolve(true);
                });
                s.once("error", () => resolve(false));
                s.once("timeout", () => {
                    s.destroy();
                    resolve(false);
                });
            });
            if (!tcpOk) return false;

            // Check WS 9002
            return new Promise<boolean>((resolve) => {
                const ws = new WebSocket(`ws://127.0.0.1:${PORTS.socketWs}`);
                ws.once("open", () => {
                    ws.close();
                    resolve(true);
                });
                ws.once("error", () => resolve(false));
            });
        },
        timeoutMs
    );
}

export async function waitForGit(timeoutMs = 60000): Promise<void> {
    await pollReady(
        "Git Server",
        async () => {
            try {
                const auth = Buffer.from(
                    `${CREDENTIALS.git.username}:${CREDENTIALS.git.password}`
                ).toString("base64");
                const res = await fetch(
                    `http://127.0.0.1:${PORTS.git}/test.git/info/refs?service=git-upload-pack`,
                    {
                        headers: { Authorization: `Basic ${auth}` },
                    }
                );
                return res.status === 200;
            } catch {
                return false;
            }
        },
        timeoutMs
    );
}

export async function waitForAllServices(timeoutMs = 60000): Promise<void> {
    await Promise.all([
        waitForPostgres(timeoutMs),
        waitForRedis(timeoutMs),
        waitForMySQL(timeoutMs),
        waitForMongo(timeoutMs),
        waitForRustFS(timeoutMs),
        waitForHttp(timeoutMs),
        waitForSocket(timeoutMs),
        waitForGit(timeoutMs),
    ]);
}
