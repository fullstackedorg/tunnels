import http from "node:http";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { isHttpReady } from "./compose";
import { Tunnel } from "../../fullstacked/platform/node/types/@types/tunnel";
import { tmpDir } from "./paths.ts";
import { acquireLock, getActivePids, registerProcess, unregisterProcess, runOnce, clearState, getProcessIdentifier } from "./lock.ts";
import { randomString } from "./string.ts";
import { GitProxy } from "../../fullstacked/platform/node/types/@types/git";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const lockDir = path.join(tmpDir, ".tunnel-lock");
const tunnelDir = path.join(tmpDir, ".tunnel");

let relayWorker: Worker | null = null;
let machineWorker: Worker | null = null;
let machineId: string | undefined;

function httpRequest(urlStr: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}): Promise<any> {
    const parsedUrl = new url.URL(urlStr);
    const postData = options.body ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : null;

    const reqOptions: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "GET",
        headers: {
            "Connection": "close",
            ...(options.headers || {})
        }
    };

    if (postData) {
        reqOptions.headers = {
            ...reqOptions.headers,
            "Content-Length": Buffer.byteLength(postData).toString()
        };
    }

    return new Promise((resolve, reject) => {
        const req = http.request(reqOptions, (res) => {
            const chunks: Uint8Array[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString();
                try {
                    resolve({
                        status: res.statusCode,
                        json: () => Promise.resolve(JSON.parse(text)),
                        text: () => Promise.resolve(text)
                    });
                } catch (e) {
                    resolve({
                        status: res.statusCode,
                        json: () => Promise.reject(e),
                        text: () => Promise.resolve(text)
                    });
                }
            });
        });

        req.on("error", reject);
        req.setTimeout(5000, () => {
            req.destroy(new Error("http.request timeout"));
        });

        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

export async function startTunnelServer(
    port: number,
    dataDir: string,
    withRelay?: boolean
) {
    const release = await acquireLock(lockDir);
    try {
        const activePids = getActivePids(tunnelDir);
        const currentId = getProcessIdentifier();
        const otherActivePids = activePids.filter((id) => id !== currentId);
        if (otherActivePids.length === 0) {
            clearState(tunnelDir);
        }
        registerProcess(tunnelDir);
    } finally {
        release();
    }

    await runOnce(
        {
            lockDir,
            stateDir: tunnelDir
        },
        () => {
            execSync(`npm run build`, {
                stdio: "inherit",
                cwd: path.join(currentDirectory, "../../../server")
            });
        }
    );

    relayWorker = new Worker(path.join(currentDirectory, "../../../server/dist/index.mjs"), {
        env: {
            PORT: port.toString(),
            DATA_DIR: dataDir
        }
    });
    relayWorker.on("error", (err) => console.error("relayWorker error:", err));
    relayWorker.on("exit", (code) => { if (code !== 0) console.error(`relayWorker exited with code ${code}`); });

    while (!await isHttpReady(port)) {
        console.log("waiting for tunnel server to be ready...")
        await new Promise((r) => setTimeout(r, 1000));
    }

    if (withRelay) {
        const machineRes = await httpRequest(`http://127.0.0.1:${port}/machines`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: {
                name: randomString()
            }
        });
        const { id, token } = await machineRes.json();
        machineId = id;

        machineWorker = new Worker(path.join(currentDirectory, "../../../server/dist/index.mjs"), {
            env: {
                TOKEN: token,
                RELAY_URL: `http://127.0.0.1:${port}`
            }
        });
        machineWorker.on("error", (err) => console.error("machineWorker error:", err));
        machineWorker.on("exit", (code) => { if (code !== 0) console.error(`machineWorker exited with code ${code}`); });

        const isConnected = async () => {
            try {
                const res = await httpRequest(`http://127.0.0.1:${port}/machines`);
                const items = await res.json();
                return items.find((m: any) => m.id === id && m.connected)?.connected;
            } catch {
                return false;
            }
        };

        while (!await isConnected()) {
            console.log("waiting for machine to be connected...");
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    console.log("Tunnel Server Ready");
}

export async function stopTunnelServer() {
    relayWorker?.terminate();
    machineWorker?.terminate();
    relayWorker = null;
    machineWorker = null;

    const release = await acquireLock(lockDir);
    try {
        unregisterProcess(tunnelDir);
        const remainingPids = getActivePids(tunnelDir);
        if (remainingPids.length === 0) {
            try {
                if (fs.existsSync(tunnelDir)) {
                    fs.rmSync(tunnelDir, { recursive: true, force: true });
                }
            } catch { }
        }
    } finally {
        release();
    }
}

export async function addService(tunnelServerPort: number, name: string, internalPort: number): Promise<Tunnel> {
    const res = await httpRequest(`http://127.0.0.1:${tunnelServerPort}/services`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: {
            name,
            internalHost: "127.0.0.1",
            internalPort,
            machineId
        }
    });
    const { token } = await res.json();
    return {
        host: "127.0.0.1",
        port: tunnelServerPort,
        authorization: token,
        unsecure: true
    };
}

export async function addProxy(tunnelServerPort: number, proxy: {
    name: string,
    urlProtocol: string,
    urlHost: string,
    urlPort: number,
    headers: Record<string, string>
}): Promise<GitProxy> {
    const res = await httpRequest(`http://127.0.0.1:${tunnelServerPort}/proxies`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: proxy
    });
    const { token } = await res.json();
    return {
        headers: {
            authorization: token
        },
        url: `http://127.0.0.1:${tunnelServerPort}`
    };
}