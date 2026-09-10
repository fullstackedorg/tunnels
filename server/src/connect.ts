// CONNECTED_TO_RELAY

import * as ws from "ws";
import net from "node:net";
import { pipeline } from "node:stream";
import { getEnvOrArgCLI } from "./utils/args.ts";
import packageJSON from "../package.json" with { type: "json" };
import type { RelayedServiceRequest } from "./warden/index.ts";
import { createWebSocketStream } from "./utils/ws.ts";
import cluster from "node:cluster";
import crypto from "node:crypto";
import { logger } from "./utils/logger.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type HeartbeatStatus = {
    alive: boolean;
    lastHeartbeat: number | null;
    latency?: number | null;
};

type ConnectIPCMessage = {
    reqId: string;
    data: string;
};

let lifeline: ws.WebSocket | null = null;
let shouldConnect = true;

let heartbeatStatus: HeartbeatStatus = {
    alive: false,
    lastHeartbeat: null,
    latency: null,
};

export function getHeartbeatStatus(): HeartbeatStatus {
    return { ...heartbeatStatus };
}

let nextWorkerIndex = 0;
let workers: cluster.Worker[] | null = null;
let workerActiveRequests: number[] = [];

export function getWorkerActiveRequests(): number[] {
    return [...workerActiveRequests];
}

function getLeastBusyWorkerIndex(): number {
    if (!workers || workers.length === 0) return 0;
    let minLoad = Infinity;
    let minIndex = 0;

    for (let i = 0; i < workers.length; i++) {
        const idx = (nextWorkerIndex + i) % workers.length;
        if (workerActiveRequests[idx] < minLoad) {
            minLoad = workerActiveRequests[idx];
            minIndex = idx;
        }
    }

    nextWorkerIndex = (minIndex + 1) % workers.length;
    return minIndex;
}

function attachWorkerListeners(worker: cluster.Worker) {
    worker.on("message", (msg: any) => {
        if (msg && msg.type === "request_completed") {
            if (workers) {
                const index = workers.indexOf(worker);
                if (index !== -1 && workerActiveRequests[index] !== undefined) {
                    workerActiveRequests[index] = Math.max(
                        0,
                        workerActiveRequests[index] - 1,
                    );
                    logger.info(
                        "ConnectToRelay",
                        `Worker ${index} completed request ${msg.reqId}, active: ${workerActiveRequests[index]}`,
                    );
                }
            }
        }
    });
}

async function singleConnectToRelay(relayUrl: string) {
    if (lifeline !== null) {
        throw new Error("Trying to connect while lfeline is not cleaned up.");
    }

    const headers: Record<string, string> = {
        version: packageJSON.version,
    };

    const token = getEnvOrArgCLI(["TOKEN", "token"], "string");
    if (token) {
        headers["Authorization"] = token;
    }

    const url = new URL(relayUrl);
    const heartbeatInterval =
        getEnvOrArgCLI(
            ["HEARTBEAT_INTERVAL", "heartbeat-interval"],
            "number",
        ) ?? 10000;

    let heartbeatTimer: NodeJS.Timeout | null = null;
    let isAlive = true;
    let pingSentTime: number | null = null;

    await new Promise<void>((resolve) => {
        let isResolved = false;
        let wsInstance: ws.WebSocket | null = null;

        const handleDisconnect = () => {
            if (heartbeatTimer !== null) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            heartbeatStatus = {
                alive: false,
                lastHeartbeat: heartbeatStatus.lastHeartbeat,
                latency: null,
            };
            if (lifeline === wsInstance) {
                lifeline = null;
            }
            if (!isResolved) {
                isResolved = true;
                resolve();
            }
        };

        try {
            wsInstance = new ws.WebSocket(url, { headers });
            lifeline = wsInstance;
        } catch {
            return handleDisconnect();
        }

        wsInstance.on("open", () => {
            logger.info("ConnectToRelay", `Connected to ${relayUrl}`);
            isAlive = true;
            heartbeatStatus = {
                alive: true,
                lastHeartbeat: Date.now(),
                latency: null,
            };

            heartbeatTimer = setInterval(() => {
                if (!isAlive) {
                    logger.warn(
                        "ConnectToRelay",
                        "Lifeline heartbeat missed, terminating connection",
                    );
                    wsInstance?.terminate();
                    return;
                }

                isAlive = false;
                pingSentTime = Date.now();
                wsInstance?.ping();
            }, heartbeatInterval);
            heartbeatTimer.unref();
        });

        wsInstance.on("pong", () => {
            isAlive = true;
            const now = Date.now();
            const latency = pingSentTime ? now - pingSentTime : null;
            heartbeatStatus = {
                alive: true,
                lastHeartbeat: now,
                latency,
            };
        });

        wsInstance.on("ping", () => {
            isAlive = true;
            heartbeatStatus = {
                alive: true,
                lastHeartbeat: Date.now(),
                latency: heartbeatStatus.latency,
            };
        });

        wsInstance.on("close", handleDisconnect);
        wsInstance.on("error", (err) => {
            logger.warn("ConnectToRelay", `Connection error: ${err.message}`);
            handleDisconnect();
        });
        wsInstance.on("message", onMessage);
    });
}

export function stopConnectToRelay() {
    shouldConnect = false;
    heartbeatStatus = {
        alive: false,
        lastHeartbeat: null,
        latency: null,
    };
    const current = lifeline;
    lifeline = null;
    current?.terminate();
    workers?.forEach((w) => w.kill());
    workers = null;
    workerActiveRequests = [];
}

let relayUrl: string | undefined;

export async function connectToRelay() {
    shouldConnect = true;
    relayUrl = getEnvOrArgCLI(["RELAY_URL", "relay-url"], "string");
    if (!relayUrl) {
        throw new Error("Relay URL is required");
    }

    if (cluster.isWorker) {
        process.on("disconnect", () => process.exit(0));
        process.on("error", () => {});
        process.on("message", onMessage);
        return;
    }

    const workerCount = getEnvOrArgCLI(["WORKERS", "workers", "w"], "number");
    if (workerCount) {
        workers = new Array(workerCount).fill(null).map(() => cluster.fork());
        workerActiveRequests = new Array(workerCount).fill(0);
        workers.forEach((w) => attachWorkerListeners(w));
        logger.info("ConnectToRelay", `Created ${workerCount} workers`);

        cluster.on("exit", (worker) => {
            if (workers === null) return;
            const index = workers.indexOf(worker);
            if (index !== -1) {
                logger.info(
                    "ConnectToRelay",
                    `Worker ${index} exited, replacing...`,
                );
                workerActiveRequests[index] = 0;
                const newWorker = cluster.fork();
                workers[index] = newWorker;
                attachWorkerListeners(newWorker);
            }
        });
    }

    const reconnectInterval =
        getEnvOrArgCLI(
            ["RECONNECT_TIMEOUT", "--reconnect-timeout", "-t"],
            "number",
        ) ?? 1000;

    while (shouldConnect) {
        await singleConnectToRelay(relayUrl);
        if (!shouldConnect) break;
        await sleep(reconnectInterval);
    }
}

function notifyRequestCompleted(reqId: string | null) {
    if (!reqId || !process.send || !process.connected) return;
    try {
        process.send({ reqId, type: "request_completed" }, () => {});
    } catch {
        // Parent IPC channel may be disconnected or closed
    }
}

async function onMessage(input: ws.RawData | ConnectIPCMessage | string) {
    if (workers) {
        const rawData = input.toString();
        const reqId = crypto.randomUUID();
        const workerIndex = getLeastBusyWorkerIndex();
        workerActiveRequests[workerIndex]++;
        workers[workerIndex].send({ reqId, data: rawData });
        logger.info(
            "ConnectToRelay",
            `Forwarding message ${reqId} to worker ${workerIndex} (active: ${workerActiveRequests[workerIndex]})`,
        );
        return;
    }

    let reqId: string | null = null;
    let rawJson: string;

    if (
        typeof input === "object" &&
        input !== null &&
        !Buffer.isBuffer(input) &&
        "data" in input &&
        "reqId" in input
    ) {
        reqId = (input as ConnectIPCMessage).reqId;
        rawJson = (input as ConnectIPCMessage).data;
    } else {
        rawJson = input.toString();
    }

    let message: RelayedServiceRequest;
    try {
        message = JSON.parse(rawJson) as RelayedServiceRequest;
    } catch (err) {
        logger.error(
            "ConnectToRelay",
            `Failed to parse relayed request JSON: ${err}`,
        );
        notifyRequestCompleted(reqId);
        return;
    }

    if (!relayUrl) {
        logger.error("ConnectToRelay", "Relay URL is not defined in onMessage");
        notifyRequestCompleted(reqId);
        return;
    }

    const socketTimeout =
        getEnvOrArgCLI(["SOCKET_TIMEOUT", "socket-timeout"], "number") ?? 30000;

    const socket = net.createConnection({
        host: message.service.internalHost,
        port: message.service.internalPort,
    });

    socket.setTimeout(socketTimeout);

    const websocket = new ws.WebSocket(relayUrl, {
        headers: {
            authorization: message.token,
        },
    });

    const duplex = createWebSocketStream(websocket);

    let isCleanedUp = false;
    const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        socket.destroy();
        duplex.destroy();
        websocket.close();
        notifyRequestCompleted(reqId);
    };

    socket.on("timeout", () => {
        logger.warn(
            "ConnectToRelay",
            `Socket timed out after ${socketTimeout}ms`,
        );
        cleanup();
    });

    socket.on("error", cleanup);
    socket.on("close", cleanup);
    websocket.on("error", cleanup);
    websocket.on("close", cleanup);

    pipeline(duplex, socket, () => {
        cleanup();
    });
    pipeline(socket, duplex, () => {
        cleanup();
    });
}
