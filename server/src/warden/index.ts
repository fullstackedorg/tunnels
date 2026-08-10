import http from "node:http";
import * as ws from "ws";
import { getByToken, invalidateItem } from "../entities/index";
import { Machine, machinesTable } from "../entities/schema/machine";
import { createWebSocketStream, upgradeRequest } from "../utils/ws";
import * as stream from "node:stream";
import { Service } from "../entities/schema/service";
import { generateToken } from "../utils/token";
import { executeHook } from "../utils/hooks";
import { update } from "../storage/index";

const machineLifelines = new Map<string, ws.WebSocket>();

export async function wardenRequest(req: http.IncomingMessage) {
    const token = req.headers.authorization;
    if (!token) {
        return req.destroy();
    }

    const machine = (await getByToken(machinesTable, token)) as Machine | null;
    if (machine) {
        return lifelineRequest(req, machine);
    }

    const relayedServiceConnection = relayedServiceRequests.get(token);
    if (relayedServiceConnection) {
        const ws = await upgradeRequest(req);
        const duplex = createWebSocketStream(ws);
        relayedServiceConnection(duplex);
        return req.socket.resume();
    }

    req.destroy();
}

export function isMachineConnected(machine: Machine) {
    return machineLifelines.has(machine.id);
}

export async function lifelineRequest(
    req: http.IncomingMessage,
    machine: Machine,
) {
    const version = (req.headers["version"] as string) || "unknown version";
    update(machinesTable, machine.id, { version }).then(() =>
        invalidateItem(machinesTable, machine.token),
    );

    const ws = await upgradeRequest(req);
    machineLifelines.set(machine.id, ws);
    ws.on("close", () => machineLifelines.delete(machine.id));
    await executeHook("machine_connect", req);
    req.socket.resume();
}

const relayedServiceRequests = new Map<string, (ws: stream.Duplex) => void>();

export type RelayedServiceRequest = {
    token: string;
    service: Service;
};

export function getRelayedService(service: Service): Promise<stream.Duplex> {
    if (!service.machineId) {
        throw new Error("Service is not relayed");
    }
    const lifeline = machineLifelines.get(service.machineId);

    if (!lifeline) {
        throw new Error("Machine is not connected");
    }

    const token = generateToken();

    return new Promise<stream.Duplex>((resolve) => {
        relayedServiceRequests.set(token, resolve);
        const message: RelayedServiceRequest = {
            token,
            service,
        };
        lifeline.send(JSON.stringify(message));
    });
}
