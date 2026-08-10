import path from "node:path";
import child_process from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import pg from "pg";
import { createClient } from "redis";
import mysql from "mysql2/promise";

import { tmpDir } from "./paths";
import { acquireLock, getActivePids, registerProcess, unregisterProcess, runOnce, getProcessIdentifier, clearState } from "./lock.ts";

const composeFile = "compose.yml";
const envFile = "test-env";
const lockDir = path.join(tmpDir, ".compose-lock");
const composeDir = path.join(tmpDir, ".compose");

dotenv.config({ path: envFile });


export function isPortOpen(port: number, host = "localhost", timeoutMs = 500): Promise<boolean> {
    if (!port || isNaN(port)) return Promise.resolve(false);
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => {
            socket.destroy();
            resolve(false);
        });
        socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, host);
    });
}

async function isMongoReady(): Promise<boolean> {
    const port = Number(process.env.MONGODB_PORT);
    if (!port || !(await isPortOpen(port))) return false;

    const client = new MongoClient(`mongodb://${process.env.USERNAME!}:${process.env.PASSWORD!}@localhost:${port}`, {
        serverSelectionTimeoutMS: 2000,
        connectTimeoutMS: 2000
    });
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });
        return true;
    } catch {
        return false;
    } finally {
        try { await client.close(true); } catch { }
    }
}

async function isPostgresReady(): Promise<boolean> {
    const port = Number(process.env.POSTGRES_PORT);
    if (!port || !(await isPortOpen(port))) return false;

    const client = new pg.Client({
        host: "localhost",
        port,
        user: process.env.USERNAME!,
        password: process.env.PASSWORD!,
        database: "postgres",
        connectionTimeoutMillis: 2000
    });
    try {
        await client.connect();
        await client.query("SELECT 1");
        return true;
    } catch {
        return false;
    } finally {
        try { await client.end(); } catch { }
    }
}

async function isRedisReady(): Promise<boolean> {
    const port = Number(process.env.REDIS_PORT);
    if (!port || !(await isPortOpen(port))) return false;

    const client = createClient({
        url: `redis://:${process.env.PASSWORD!}@localhost:${port}`,
        socket: { connectTimeout: 2000, reconnectStrategy: false }
    });
    client.on("error", () => { });
    try {
        await client.connect();
        const res = await client.ping();
        return res === "PONG";
    } catch {
        return false;
    } finally {
        try { client.destroy(); } catch { }
    }
}

async function isMySQLReady(): Promise<boolean> {
    const port = Number(process.env.MYSQL_PORT);
    if (!port || !(await isPortOpen(port))) return false;

    let conn: mysql.Connection | undefined;
    try {
        conn = await mysql.createConnection({
            host: "localhost",
            port,
            user: "root",
            password: process.env.PASSWORD!,
            connectTimeout: 2000
        });
        await conn.ping();
        return true;
    } catch {
        return false;
    } finally {
        if (conn) {
            try { await conn.end(); } catch { }
            try { conn.destroy(); } catch { }
        }
    }
}

export async function isHttpReady(port: number): Promise<boolean> {
    if (!port || isNaN(port)) return false;
    return new Promise((resolve) => {
        const req = http.get(
            `http://localhost:${port}`,
            { headers: { connection: "close" } },
            (res) => {
                res.resume();
                req.destroy();
                resolve(res.statusCode !== undefined);
            }
        );
        req.on("error", () => {
            req.destroy();
            resolve(false);
        });
        req.setTimeout(1000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

export async function isGitServerReady(port: number): Promise<boolean> {
    if (!port || isNaN(port)) return false;
    const user = process.env.USERNAME || "test";
    const password = process.env.PASSWORD || "testing";
    const auth = Buffer.from(`${user}:${password}`).toString("base64");

    return new Promise((resolve) => {
        const req = http.get(
            `http://localhost:${port}/test/info/refs?service=git-upload-pack`,
            {
                headers: {
                    Authorization: `Basic ${auth}`,
                    connection: "close"
                }
            },
            (res) => {
                res.resume();
                req.destroy();
                resolve(res.statusCode === 200);
            }
        );
        req.on("error", () => {
            req.destroy();
            resolve(false);
        });
        req.setTimeout(1000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function checkBaseServicesReady(): Promise<boolean> {
    const [mongo, postgres, redis, mysqlReady, seaweed, gitServer] = await Promise.all([
        isMongoReady(),
        isPostgresReady(),
        isRedisReady(),
        isMySQLReady(),
        isHttpReady(Number(process.env.S3_PORT)),
        isHttpReady(Number(process.env.GIT_SERVER_PORT))
    ]);
    return mongo && postgres && redis && mysqlReady && seaweed && gitServer;
}

async function checkAllServicesReady(): Promise<boolean> {
    const baseReady = await checkBaseServicesReady();
    if (!baseReady) return false;
    return isGitServerReady(Number(process.env.GIT_SERVER_PORT));
}

async function ensureGitServerSetup(): Promise<void> {
    if (await isGitServerReady(Number(process.env.GIT_SERVER_PORT))) {
        return;
    }
    const start = Date.now();
    while (Date.now() - start < 20000) {
        try {
            child_process.execSync(
                `docker-compose --env-file "${envFile}" -f "${composeFile}" exec -T git-server /bin/bash /home/setup.sh`,
                { stdio: "ignore" }
            );
            if (await isGitServerReady(Number(process.env.GIT_SERVER_PORT))) {
                return;
            }
        } catch {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
}

export async function startDockerCompose(timeoutMs = 60000) {
    const release = await acquireLock(lockDir);
    try {
        const activePids = getActivePids(composeDir);
        const currentId = getProcessIdentifier();
        const otherActivePids = activePids.filter((id) => id !== currentId);
        const isFirstProcess = otherActivePids.length === 0;

        registerProcess(composeDir);

        if (isFirstProcess) {
            clearState(composeDir);
            child_process.execSync(`docker-compose --env-file "${envFile}" -f "${composeFile}" down`, { stdio: "inherit" });
        }
    } finally {
        release();
    }

    await runOnce(
        {
            lockDir,
            stateDir: composeDir,
            timeoutMs,
            retryIntervalMs: 500,
            isReady: checkAllServicesReady
        },
        async () => {
            child_process.execSync(`docker-compose --env-file "${envFile}" -f "${composeFile}" up -d --build`, { stdio: "inherit" });

            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                if (await checkBaseServicesReady()) {
                    await ensureGitServerSetup();
                    if (await checkAllServicesReady()) {
                        return;
                    }
                }
                await new Promise((r) => setTimeout(r, 500));
            }
            throw new Error("Timed out waiting for Docker Compose services to be ready");
        }
    );

    console.log("Docker Compose Ready");
}

export async function stopDockerCompose() {
    const release = await acquireLock(lockDir);
    try {
        unregisterProcess(composeDir);
        const remainingPids = getActivePids(composeDir);

        if (remainingPids.length > 0) {
            console.log(`Skipping Docker Compose state cleanup, ${remainingPids.length} test runner(s) still active (PIDs: ${remainingPids.join(", ")})`);
            return;
        }

        console.log("Last standing test runner stopping Docker Compose...");
        child_process.execSync(`docker-compose --env-file "${envFile}" -f "${composeFile}" down`, { stdio: "inherit" });

        try {
            if (fs.existsSync(composeDir)) {
                fs.rmSync(composeDir, { recursive: true, force: true });
            }
        } catch { }
    } finally {
        release();
    }
}