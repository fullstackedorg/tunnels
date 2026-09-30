import { Worker } from "node:worker_threads";
import { type HubInstance } from "../../../src/hub/index.ts";
import { type EdgeInstance } from "../../../src/edge/index.ts";
import { getAvailablePort, createTempDir, cleanupTempDir, jsonFetch } from "../../helpers.ts";

export interface IntegrationHarness {
    hub?: HubInstance;
    hubPort: number;
    hubUrl: string;
    dataDir: string;
    edge?: EdgeInstance;
    edgeId?: string;
    close: () => Promise<void>;
}

export async function setupIntegrationHarness(withEdge = false): Promise<IntegrationHarness> {
    const dataDir = createTempDir("integ-hub-");

    const worker = new Worker(new URL("./hub-worker.ts", import.meta.url), {
        workerData: { hubPort: 0, dataDir },
    });

    const hubPort = await new Promise<number>((resolve, reject) => {
        const onMsg = (msg: any) => {
            if (msg.type === "hub_ready") {
                worker.off("error", reject);
                resolve(msg.hubPort);
            }
        };
        worker.on("message", onMsg);
        worker.once("error", reject);
    });
    const hubUrl = `http://127.0.0.1:${hubPort}`;

    let edgeId: string | undefined;

    if (withEdge) {
        const edgeRes = await jsonFetch(`${hubUrl}/edges`, {
            method: "POST",
            body: { name: "Integration Test Edge" },
        });
        edgeId = edgeRes.data.id;
        const edgeToken = edgeRes.data.token;

        await new Promise<void>((resolve, reject) => {
            const onMsg = (msg: any) => {
                if (msg.type === "edge_ready") {
                    worker.off("error", reject);
                    resolve();
                }
            };
            worker.on("message", onMsg);
            worker.once("error", reject);
            worker.postMessage({ type: "start_edge", edgeToken });
        });

        // Wait for edge lifeline connection
        let connected = false;
        for (let i = 0; i < 50; i++) {
            const check = await jsonFetch(`${hubUrl}/edges/${edgeId}`);
            if (check.data?.connected) {
                connected = true;
                break;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        if (!connected) {
            throw new Error(`Edge ${edgeId} failed to connect to Hub in time`);
        }
    }

    return {
        hubPort,
        hubUrl,
        dataDir,
        edgeId,
        close: async () => {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    worker.terminate().then(() => resolve());
                }, 2000);
                worker.once("message", (msg) => {
                    if (msg?.type === "closed") {
                        clearTimeout(timer);
                        worker.terminate().then(() => resolve());
                    }
                });
                worker.postMessage({ type: "close" });
            });
            cleanupTempDir(dataDir);
        },
    };
}

export async function createDirectTunnel(
    hubUrl: string,
    internalPort: number,
    internalHost = "127.0.0.1",
    name = "Direct Tunnel"
): Promise<{ tunnelId: string; token: string }> {
    const res = await jsonFetch(`${hubUrl}/tunnels`, {
        method: "POST",
        body: {
            name,
            internalHost,
            internalPort,
        },
    });
    if (res.status !== 201) {
        throw new Error(`Failed to create direct tunnel: ${JSON.stringify(res.data)}`);
    }
    return { tunnelId: res.data.id, token: res.data.token };
}

export async function createRelayedTunnel(
    hubUrl: string,
    edgeId: string,
    internalPort: number,
    internalHost = "127.0.0.1",
    name = "Relayed Tunnel"
): Promise<{ tunnelId: string; token: string }> {
    const res = await jsonFetch(`${hubUrl}/tunnels`, {
        method: "POST",
        body: {
            name,
            internalHost,
            internalPort,
            edgeId,
        },
    });
    if (res.status !== 201) {
        throw new Error(`Failed to create relayed tunnel: ${JSON.stringify(res.data)}`);
    }
    return { tunnelId: res.data.id, token: res.data.token };
}
