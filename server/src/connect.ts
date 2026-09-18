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
import { executeHook } from "./utils/hooks.ts";
import {
    createIncomingMessageWithDeny,
    type IncomingMessageWithDeny,
} from "./http/index.ts";

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
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "request_completed") {
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

export async function onMessage(input: ws.RawData | ConnectIPCMessage | string) {
    if (workers) {
        const rawData = input.toString();
        let parsedReqId: string | undefined;
        let parsedService: any;
        try {
            const parsed = JSON.parse(rawData);
            if (parsed && parsed.reqId) parsedReqId = parsed.reqId;
            if (parsed && parsed.service) parsedService = parsed.service;
        } catch {}

        if (!parsedReqId) {
            logger.error(
                "ConnectToRelay",
                `Received relayed request from relay with no reqId, canceling execution: ${rawData.slice(0, 200)}`,
            );
            return;
        }

        const reqId = parsedReqId;
        const workerIndex = getLeastBusyWorkerIndex();
        workerActiveRequests[workerIndex]++;
        workers[workerIndex].send({ reqId, data: rawData });
        const serviceInfo = parsedService
            ? ` for service "${parsedService.name || parsedService.id}" (${parsedService.internalHost}:${parsedService.internalPort})`
            : "";
        logger.info(
            "ConnectToRelay",
            `Forwarding message ${reqId} to worker ${workerIndex} (active: ${workerActiveRequests[workerIndex]})${serviceInfo}`,
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

    if (message.reqId) {
        reqId = message.reqId;
    }

    if (!reqId) {
        logger.error(
            "ConnectToRelay",
            `Relayed request message has no reqId, canceling execution: ${rawJson.slice(0, 200)}`,
        );
        notifyRequestCompleted(reqId);
        return;
    }

    if (!message.service || !message.token) {
        logger.error(
            "ConnectToRelay",
            `Relayed request message missing service or token, canceling execution (reqId: ${reqId})`,
        );
        notifyRequestCompleted(reqId);
        return;
    }

    if (!relayUrl) {
        logger.error("ConnectToRelay", "Relay URL is not defined in onMessage");
        notifyRequestCompleted(reqId);
        return;
    }

    const service = message.service;
    const workerLabel = cluster.isWorker
        ? `Worker ${cluster.worker?.id ?? 0}`
        : "SingleProcess";
    const startTime = Date.now();
    let bytesTargetToClient = 0;
    let bytesClientToTarget = 0;
    let isSocketConnected = false;
    let isWsConnected = false;

    const socketTimeout =
        getEnvOrArgCLI(["SOCKET_TIMEOUT", "socket-timeout"], "number") ?? 30000;
    const connectTimeoutMs =
        getEnvOrArgCLI(
            ["CONNECT_TIMEOUT", "connect-timeout"],
            "number",
        ) ?? 10000;

    const socket = net.createConnection({
        host: service.internalHost,
        port: service.internalPort,
    });

    socket.setKeepAlive(true, 15000);
    socket.setNoDelay(true);

    const req = createIncomingMessageWithDeny({
        id: reqId,
        socket,
        headers: message.headers,
        url: message.url || `/${service.name || service.id}`,
        deny: () => {
            socket.destroy();
        },
    });

    logger.info(
        "ConnectToRelay",
        `[${workerLabel}] Starting request ${req.id || "direct"} for service "${service.name || service.id}" -> ${service.internalHost}:${service.internalPort}`,
    );

    await executeHook("machine_service_request", req, service);

    if (req.destroyed) {
        socket.destroy();
        notifyRequestCompleted(reqId);
        return;
    }

    let connectTimer: NodeJS.Timeout | null = setTimeout(() => {
        if (!isSocketConnected) {
            logger.warn(
                "ConnectToRelay",
                `[${workerLabel}] Target socket connect timed out after ${connectTimeoutMs}ms connecting to ${service.internalHost}:${service.internalPort} (reqId: ${reqId})`,
            );
            executeHook("machine_service_timeout", req, service, {
                phase: "connect",
                socketConnected: false,
                bytesTargetToClient,
                bytesClientToTarget,
            });
            cleanup("connect_timeout");
        }
    }, connectTimeoutMs);
    connectTimer.unref();

    socket.on("connect", () => {
        if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
        }
        isSocketConnected = true;
        const connectLatency = Date.now() - startTime;
        logger.info(
            "ConnectToRelay",
            `[${workerLabel}] Target socket connected to ${service.internalHost}:${service.internalPort} in ${connectLatency}ms (reqId: ${reqId})`,
        );
        if (isWsConnected) {
            executeHook(
                "machine_service_connected",
                req,
                service,
                duplex,
                socket,
            );
        }
    });

    if (socketTimeout > 0) {
        socket.setTimeout(socketTimeout);
    }

    const wsStartTime = Date.now();
    const websocket = new ws.WebSocket(relayUrl, {
        headers: {
            authorization: message.token,
        },
    });

    websocket.on("open", () => {
        isWsConnected = true;
        const wsLatency = Date.now() - wsStartTime;
        logger.info(
            "ConnectToRelay",
            `[${workerLabel}] Relay WebSocket tunnel opened in ${wsLatency}ms (reqId: ${reqId})`,
        );
        if (isSocketConnected) {
            executeHook(
                "machine_service_connected",
                req,
                service,
                duplex,
                socket,
            );
        }
    });

    const duplex = createWebSocketStream(websocket);

    let isCleanedUp = false;
    const cleanup = (reason: string = "normal") => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
        }
        socket.destroy();
        duplex.destroy();
        websocket.close();
        notifyRequestCompleted(reqId);
        const duration = Date.now() - startTime;
        logger.info(
            "ConnectToRelay",
            `[${workerLabel}] Completed request ${reqId || "direct"} for ${service.name} (duration: ${duration}ms, target->client: ${bytesTargetToClient}B, client->target: ${bytesClientToTarget}B, reason: ${reason})`,
        );
        executeHook("machine_service_end", req, service, {
            durationMs: duration,
            bytesIn: bytesClientToTarget,
            bytesOut: bytesTargetToClient,
            reason,
        });
    };

    socket.on("timeout", () => {
        logger.warn(
            "ConnectToRelay",
            `[${workerLabel}] Socket timed out after ${socketTimeout}ms (reqId: ${reqId}, socketConnected: ${isSocketConnected}, wsConnected: ${isWsConnected}, in: ${bytesClientToTarget}B, out: ${bytesTargetToClient}B)`,
        );
        executeHook("machine_service_timeout", req, service, {
            phase: "idle",
            socketConnected: isSocketConnected,
            bytesTargetToClient,
            bytesClientToTarget,
        });
        cleanup("socket_timeout");
    });

    socket.on("data", (chunk: Buffer) => {
        if (bytesTargetToClient === 0) {
            logger.info(
                "ConnectToRelay",
                `[${workerLabel}] Received first bytes from target ${service.name} (${chunk.length}B, reqId: ${reqId})`,
            );
        }
        bytesTargetToClient += chunk.length;
    });

    duplex.on("data", (chunk: Buffer) => {
        if (bytesClientToTarget === 0) {
            logger.info(
                "ConnectToRelay",
                `[${workerLabel}] Received first bytes from client for ${service.name} (${chunk.length}B, reqId: ${reqId})`,
            );
        }
        bytesClientToTarget += chunk.length;
    });

    socket.on("error", (err) => {
        logger.warn(
            "ConnectToRelay",
            `[${workerLabel}] Target socket error for ${service.name} (${service.internalHost}:${service.internalPort}): ${err.message} (reqId: ${reqId})`,
        );
        cleanup("socket_error: " + err.message);
    });
    socket.on("close", (hadError) => {
        cleanup(hadError ? "socket_close_with_error" : "socket_close");
    });

    websocket.on("error", (err) => {
        logger.warn(
            "ConnectToRelay",
            `[${workerLabel}] Relay WebSocket error for ${service.name}: ${err.message} (reqId: ${reqId})`,
        );
        cleanup("websocket_error: " + err.message);
    });
    websocket.on("close", (code, reason) => {
        cleanup(`websocket_close:${code}:${reason}`);
    });

    pipeline(duplex, socket, () => {
        cleanup("duplex_to_socket_ended");
    });
    pipeline(socket, duplex, () => {
        cleanup("socket_to_duplex_ended");
    });
}
