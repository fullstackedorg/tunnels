// CONNECTED_TO_RELAY

import * as ws from "ws";
import net from "node:net";
import { pipeline } from "node:stream";
import { getEnvOrArgCLI } from "./utils/args";
import packageJSON from "../package.json" with { type: "json" };
import { RelayedServiceRequest } from "./warden";
import { createWebSocketStream } from "./utils/ws";
import cluster from "node:cluster";
import { logger } from "./utils/logger";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let lifeline: ws.WebSocket | null = null;
let shouldConnect = true;

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

    await new Promise<void>((resolve) => {
        const handleDisconnect = () => {
            if (lifeline === null) return;
            lifeline = null;
            resolve();
        };

        try {
            lifeline = new ws.WebSocket(url, { headers });
        } catch {
            return handleDisconnect();
        }

        lifeline.on("open", () =>
            logger.info("ConnectToRelay", `Connected to ${relayUrl}`),
        );

        lifeline.on("close", handleDisconnect);
        lifeline.on("error", handleDisconnect);
        lifeline.on("message", onMessage);
    });
}

export function stopConnectToRelay() {
    shouldConnect = false;
    lifeline?.close();
    lifeline = null;
    workers?.forEach((w) => w.kill());
    workers = null;
}

let relayUrl: string | undefined;

export async function connectToRelay() {
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
