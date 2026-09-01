import http from "node:http";
import * as ws from "ws";
import cluster from "node:cluster";
import { getByToken, invalidateItem } from "../entities/index.ts";
import { machinesTable, type Machine } from "../entities/schema/machine.ts";
import { createWebSocketStream, upgradeRequest } from "../utils/ws.ts";
import * as stream from "node:stream";
import { type Service } from "../entities/schema/service.ts";
import { generateToken } from "../utils/token.ts";
import { executeHook } from "../utils/hooks.ts";
import { update } from "../storage/index.ts";
import { logger } from "../utils/logger.ts";
import net from "node:net";
import * as KV from "../kv/index.ts";
import type { IncomingMessageWithDeny } from "../http/index.ts";
import { getEnvOrArgCLI } from "../utils/args.ts";

export type HeartbeatStatus = {
    alive: boolean;
    lastHeartbeat: number | null;
    latency?: number | null;
};

const machineLifelines = new Map<string, ws.WebSocket>();
const machineHeartbeats = new Map<string, HeartbeatStatus>();

export async function getMachineHeartbeatStatus(
    machineId: string,
): Promise<HeartbeatStatus | null> {
    if (machineHeartbeats.has(machineId)) {
        return machineHeartbeats.get(machineId)!;
    }
    return KV.get<HeartbeatStatus>(`machine_heartbeat_${machineId}`);
}

export function getLocalMachineHeartbeatStatus(
    machineId: string,
): HeartbeatStatus | null {
    return machineHeartbeats.get(machineId) ?? null;
}

function getWorkerId(): number {
    return cluster.worker?.id ?? 0;
}

function sendToParent(message: WardenMessageIPC, socket?: net.Socket) {
    process.send?.(message, socket);
}

export type WardenMessageIPC =
    | ({
          type: "relayed_service_request";
          targetWorkerId: number;
      } & RelayedServiceRequest)
    | {
          type: "relayed_service_socket";
          targetWorkerId: number;
          token: string;
          headers: http.IncomingHttpHeaders;
          url: string | undefined;
      };

if (cluster.isWorker) {
    process.on(
        "message",
        async (message: WardenMessageIPC, socket?: net.Socket) => {
            if (!message || typeof message !== "object") return;
            logger.info(
                "Warden Worker",
                `Worker ${getWorkerId()} got IPC message type=${message.type}`,
            );

            if (message.type === "relayed_service_request") {
                const { token, service } = message as RelayedServiceRequest & {
                    type: string;
                };
                if (service?.machineId) {
                    const lifeline = machineLifelines.get(service.machineId);
                    logger.info(
                        "Warden Worker",
                        `Worker ${getWorkerId()} sending RelayedServiceRequest on lifeline found=${!!lifeline}`,
                    );
                    if (lifeline) {
                        const reqMsg: RelayedServiceRequest = {
                            token,
                            service,
                        };
                        lifeline.send(JSON.stringify(reqMsg));
                    }
                }
            } else if (message.type === "relayed_service_socket" && socket) {
                const token = message.token;
                const relayedServiceConnection =
                    relayedServiceRequests.get(token);
                logger.info(
                    "Warden Worker",
                    `Worker ${getWorkerId()} got relayed_service_socket token=${token} found=${!!relayedServiceConnection}`,
                );
                if (relayedServiceConnection) {
                    relayedServiceRequests.delete(token);
                    KV.del(`relayed_request:${token}`);
                    const mockReq = Object.assign(
                        new http.IncomingMessage(socket),
                        {
                            headers: message.headers || {},
                            url: message.url || "",
                            method: "GET",
                            httpVersion: "1.1",
                            httpVersionMajor: 1,
                            httpVersionMinor: 1,
                        },
                    ) as IncomingMessageWithDeny;
                    const ws = await upgradeRequest(mockReq);
                    const duplex = createWebSocketStream(ws);
                    relayedServiceConnection(duplex);
                    socket.resume();
                }
            }
        },
    );
}

export async function wardenRequest(req: IncomingMessageWithDeny) {
    const token = req.headers.authorization;
    if (!token) {
        return req.deny();
    }

    const machine = (await getByToken(machinesTable, token)) as Machine | null;
    if (machine) {
        return lifelineRequest(req, machine);
    }

    const relayedServiceConnection = relayedServiceRequests.get(token);
    if (relayedServiceConnection) {
        relayedServiceRequests.delete(token);
        KV.del(`relayed_request:${token}`);
        const ws = await upgradeRequest(req);
        const duplex = createWebSocketStream(ws);
        relayedServiceConnection(duplex);
        return req.socket.resume();
    }

    const originWorkerId = await KV.get<number>(`relayed_request:${token}`);
    if (originWorkerId !== null && originWorkerId !== getWorkerId()) {
        req.socket.pause();
        sendToParent(
            {
                type: "relayed_service_socket",
                targetWorkerId: originWorkerId,
                token,
                headers: req.headers,
                url: req.url,
            },
            req.socket,
        );
        return;
    }

    req.deny();
}

export async function isMachineConnected(machine: Machine) {
    if (machineLifelines.has(machine.id)) {
        return true;
    }
    const workerId = await KV.get<number>(`machine_lifeline_${machine.id}`);
    return workerId !== null;
}

export async function lifelineRequest(
    req: IncomingMessageWithDeny,
    machine: Machine,
) {
    const version = (req.headers["version"] as string) || "unknown version";
    update(machinesTable, machine.id, { version })
        .then(() => invalidateItem(machinesTable, machine.token))
        .catch(() => {});

    const ws = await upgradeRequest(req);
    machineLifelines.set(machine.id, ws);
    const workerId = getWorkerId();
    await KV.set(`machine_lifeline_${machine.id}`, workerId);

    const initialStatus: HeartbeatStatus = {
        alive: true,
        lastHeartbeat: Date.now(),
        latency: null,
    };
    machineHeartbeats.set(machine.id, initialStatus);
    await KV.set(`machine_heartbeat_${machine.id}`, initialStatus);

    const heartbeatInterval =
        getEnvOrArgCLI(
            ["HEARTBEAT_INTERVAL", "heartbeat-interval"],
            "number",
        ) ?? 10000;

    let isAlive = true;
    let pingSentTime: number | null = null;

    const heartbeatTimer = setInterval(async () => {
        if (!isAlive) {
            logger.warn(
                "Warden",
                `Heartbeat missed for machine ${machine.id}, terminating lifeline`,
            );
            ws.terminate();
            return;
        }

        isAlive = false;
        pingSentTime = Date.now();
        ws.ping();
    }, heartbeatInterval);

    ws.on("pong", async () => {
        isAlive = true;
        const now = Date.now();
        const latency = pingSentTime ? now - pingSentTime : null;
        const status: HeartbeatStatus = {
            alive: true,
            lastHeartbeat: now,
            latency,
        };
        machineHeartbeats.set(machine.id, status);
        await KV.set(`machine_heartbeat_${machine.id}`, status);
    });

    ws.on("ping", async () => {
        isAlive = true;
        const now = Date.now();
        const prev = machineHeartbeats.get(machine.id);
        const status: HeartbeatStatus = {
            alive: true,
            lastHeartbeat: now,
            latency: prev?.latency ?? null,
        };
        machineHeartbeats.set(machine.id, status);
        await KV.set(`machine_heartbeat_${machine.id}`, status);
    });

    const cleanup = async () => {
        clearInterval(heartbeatTimer);
        machineLifelines.delete(machine.id);
        machineHeartbeats.delete(machine.id);
        await KV.del(`machine_lifeline_${machine.id}`);
        await KV.del(`machine_heartbeat_${machine.id}`);
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);

    await executeHook("machine_connect", req);
    req.socket.resume();
}

const relayedServiceRequests = new Map<string, (ws: stream.Duplex) => void>();

export type RelayedServiceRequest = {
    token: string;
    service: Service;
};

export async function getRelayedService(
    service: Service,
): Promise<stream.Duplex> {
    if (!service.machineId) {
        throw new Error("Service is not relayed");
    }

    const workerId = getWorkerId();
    let targetWorkerId: number | null = null;

    if (machineLifelines.has(service.machineId)) {
        targetWorkerId = workerId;
    } else {
        targetWorkerId = await KV.get<number>(
            `machine_lifeline_${service.machineId}`,
        );
    }

    if (targetWorkerId === null) {
        throw new Error("Machine is not connected");
    }

    const token = generateToken();
    await KV.set(`relayed_request:${token}`, workerId);

    return new Promise<stream.Duplex>((resolve) => {
        relayedServiceRequests.set(token, resolve);
        const message: RelayedServiceRequest = {
            token,
            service,
        };

        if (targetWorkerId === workerId) {
            const lifeline = machineLifelines.get(service.machineId!);
            if (lifeline) {
                lifeline.send(JSON.stringify(message));
            }
        } else {
            sendToParent({
                type: "relayed_service_request",
                targetWorkerId,
                token,
                service,
            });
        }
    });
}
