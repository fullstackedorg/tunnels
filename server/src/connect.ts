// CONNECTED_TO_RELAY

import * as ws from "ws";
import net from "node:net";
import { pipeline } from "node:stream";
import { getEnvOrArgCLI } from "./utils/args.ts";
import packageJSON from "../package.json" with { type: "json" };
import type { RelayedServiceRequest } from "./warden/index.ts";
import { createWebSocketStream } from "./utils/ws.ts";
import cluster from "node:cluster";
import { logger } from "./utils/logger.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type HeartbeatStatus = {
    alive: boolean;
    lastHeartbeat: number | null;
    latency?: number | null;
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
        wsInstance.on("error", handleDisconnect);
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
}

let relayUrl: string | undefined;

export async function connectToRelay() {
    shouldConnect = true;
    relayUrl = getEnvOrArgCLI(["RELAY_URL", "relay-url"], "string");
    if (!relayUrl) {
        throw new Error("Relay URL is required");
    }

    if (cluster.isWorker) {
        process.on("message", onMessage);
        return;
    }

    const workerCount = getEnvOrArgCLI(["WORKERS", "workers", "w"], "number");
    if (workerCount) {
        workers = new Array(workerCount).fill(null).map(() => cluster.fork());
        logger.info("ConnectToRelay", `Created ${workerCount} workers`);

        cluster.on("exit", (worker) => {
            if (workers === null) return;
            const index = workers.indexOf(worker);
            if (index !== -1) {
                logger.info(
                    "ConnectToRelay",
                    `Worker ${index} exited, replacing...`,
                );
                workers[index] = cluster.fork();
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

async function onMessage(data: string) {
    if (workers) {
        const workerIndex = nextWorkerIndex;
        nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
        workers[workerIndex].send(data.toString());
        logger.info(
            "ConnectToRelay",
            `Forwarding message to worker ${workerIndex}`,
        );
        return;
    }

    const message = JSON.parse(data.toString()) as RelayedServiceRequest;

    const socket = net.createConnection({
        host: message.service.internalHost,
        port: message.service.internalPort,
    });

    const websocket = new ws.WebSocket(relayUrl!, {
        headers: {
            authorization: message.token,
        },
    });

    const duplex = createWebSocketStream(websocket);

    const cleanup = () => {
        socket.destroy();
        duplex.destroy();
        websocket.close();
    };

    socket.on("error", cleanup);
    websocket.on("error", cleanup);

    pipeline(duplex, socket, () => {});
    pipeline(socket, duplex, () => {});
}
