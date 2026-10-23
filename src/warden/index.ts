import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import type { Edge, Tunnel } from "../entities/schema.ts";
import { isReason, MAX_STREAMS_PER_RELAY, RELAY_WORKER_HEADER, type Reason } from "../constants.ts";
import { logger } from "../utils/logger.ts";
import { kv } from "../kv/index.ts";
import { runGatingHook } from "../utils/hooks.ts";
import { createWebSocketServer } from "../ws/index.ts";
import { setSeverEdgeListener } from "../tunnels/registry.ts";
import {
    getLocalLifeline,
    sendOpenRelay,
    closeLifelineLocally,
    closeAllLifelines,
    setClusterIpcSender as setLifelineClusterIpc,
    setPresenceHeartbeatTimeout,
} from "./lifeline.ts";
import {
    closeRelays,
    configureRelays,
    liveRelays,
    placeStream,
    registerRelay,
    relayRequestFailed,
    stopRelays,
    type Relay,
} from "./relays.ts";
import type { RelayStreamOpen } from "./types.ts";

export {
    isEdgeOnline,
    wardenLifeline,
    closeLifelineLocally,
    closeLifeline,
    setWardenBootId,
} from "./lifeline.ts";

export { RELAY_WORKER_HEADER } from "../constants.ts";

let clusterIpcSender: ((msg: any, handle?: any) => void) | null = null;

/** Applies the Hub settings the Warden depends on. */
export function configureWarden(options: { heartbeatTimeout: number }) {
    setPresenceHeartbeatTimeout(options.heartbeatTimeout);
    configureRelays({ request: routeRelayRequest, keepWarm: (id) => !!getLocalLifeline(id) });
    setSeverEdgeListener((edgeId, reason) => closeRelays(edgeId, reason));
}

/** Hub shutdown: close lifelines (streams waiting for a relay session fail). */
export async function shutdownWarden(reason: Reason = "hub_shutdown"): Promise<void> {
    await closeAllLifelines(reason);
}

/** Hub shutdown, once runtime sessions drained: close every relay session. */
export function closeAllRelays(reason: Reason = "hub_shutdown"): void {
    closeRelays(null, reason);
    stopRelays();
}

export function setWardenClusterIpcSender(sender: ((msg: any, handle?: any) => void) | null): void {
    clusterIpcSender = sender;
    setLifelineClusterIpc(sender);
}

// Asks the Edge for a relay session to this worker, through the lifeline worker if not here.
function routeRelayRequest(edgeId: string): void {
    const worker = logger.getWorkerIdentity();
    if (sendOpenRelay(edgeId, worker)) return;
    if (!clusterIpcSender) {
        relayRequestFailed(edgeId, "edge_disconnected");
        return;
    }
    kv.get<string>(`edge:${edgeId}:worker`).then(
        (lifelineWorker) => {
            if (!lifelineWorker || lifelineWorker === worker) {
                relayRequestFailed(edgeId, "edge_disconnected");
            } else {
                clusterIpcSender?.({
                    type: "relay_request",
                    target: lifelineWorker,
                    edgeId,
                    worker,
                });
            }
        },
        () => relayRequestFailed(edgeId, "stream_error")
    );
}

function reasonError(reason: Reason): Error {
    const err: any = new Error(`Relayed stream failed: ${reason}`);
    err.reason = reason;
    return err;
}

/**
 * A stream to the tunnel's target through its Edge: opened on one of the Edge's relay sessions
 * (waiting for one when there is none yet), resolved once the Edge dialed the target. Fails with
 * the Edge's reason, `connect_timeout` at the deadline, or the abort reason (the runtime's stream
 * ended first), which is also sent to the Edge so it drops the dial.
 */
export async function openRelayedStream(
    tunnel: Tunnel,
    req: IncomingMessageWithDeny,
    deadline: number,
    signal?: AbortSignal
): Promise<Duplex> {
    let relay: Relay;
    try {
        relay = await placeStream(tunnel.edgeId!, deadline, signal);
    } catch (reason) {
        throw reasonError(isReason(reason) ? reason : "stream_error");
    }
    if (relay.session.size >= MAX_STREAMS_PER_RELAY) {
        relay.reserved--;
        throw reasonError("edge_saturated");
    }
    const connectTimeoutMs = deadline - Date.now();
    if (connectTimeoutMs <= 0) {
        relay.reserved--;
        throw reasonError("connect_timeout");
    }

    const open: RelayStreamOpen = {
        reqId: req.id,
        tunnel: {
            id: tunnel.id,
            name: tunnel.name,
            internalHost: tunnel.internalHost,
            internalPort: tunnel.internalPort,
            metadata: tunnel.metadata || {},
        },
        client: { ip: req.clientIp, correlationId: req.correlationId },
        connectTimeoutMs,
    };
    const session = relay.session;
    const { stream, ready } = session.startStream(JSON.stringify(open));
    relay.reserved--;

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const fail = (reason: Reason) => {
            cleanup();
            if (!stream.destroyed) {
                stream.closeReason = reason;
                stream.destroy();
            }
            reject(reasonError(reason));
        };
        const onAbort = () => fail(isReason(signal?.reason) ? signal.reason : "client_aborted");
        const timer = setTimeout(() => fail("connect_timeout"), connectTimeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        ready.then(
            () => {
                cleanup();
                resolve();
            },
            (err) => {
                const peer = err?.reason;
                // The session dropped before OPENED: no target was reached, the Edge went away
                // (target_close is only how a reasonless Edge close ends opened streams).
                if (!session.open && peer === "target_close") fail("edge_disconnected");
                else if (isReason(peer) && peer !== "client_close") fail(peer);
                else fail(session.open ? "stream_error" : "edge_disconnected");
            }
        );
        if (signal?.aborted) onAbort();
    });
    // paused like a dialed target socket: nothing flows before the splice (a server-first
    // protocol's greeting must not reach a connected hook's listener alone)
    stream.pause();
    return stream;
}

function acceptRelaySession(edgeId: string, req: IncomingMessage, socket: Duplex, head: Buffer) {
    createWebSocketServer().handleUpgrade(req, socket, head, (ws) => {
        registerRelay(edgeId, ws);
        logger.info("Warden", `Relay session of edge ${edgeId} up (${liveRelays(edgeId).length})`);
    });
}

/** A relay session upgrade (edge token + RELAY_WORKER_HEADER): kept here or moved to its worker. */
export async function wardenRelaySession(
    req: IncomingMessageWithDeny,
    socket: Duplex,
    head: Buffer,
    edge: Edge
): Promise<void> {
    const passed = await runGatingHook("lifeline_connect", req, edge);
    if (!passed || req.denied) return;

    const target = req.headers[RELAY_WORKER_HEADER];
    if (typeof target === "string" && target !== logger.getWorkerIdentity() && clusterIpcSender) {
        clusterIpcSender(
            { type: "relay_session_socket", target, edgeId: edge.id, head, headers: req.headers },
            socket
        );
        return;
    }
    acceptRelaySession(edge.id, req, socket, head);
}

export function handleWardenIpc(msg: any, handle?: any): void {
    const currentWorker = logger.getWorkerIdentity();
    if (!msg || typeof msg !== "object") return;
    if (msg.target !== currentWorker) {
        // a socket for a worker identity that is not this one (stale): nobody else will take it
        if (handle && typeof handle.destroy === "function") handle.destroy();
        return;
    }

    if (msg.type === "relay_request") {
        if (!sendOpenRelay(msg.edgeId, msg.worker)) {
            clusterIpcSender?.({
                type: "relay_failed",
                target: msg.worker,
                edgeId: msg.edgeId,
                reason: "edge_disconnected",
            });
        }
    } else if (msg.type === "relay_failed") {
        relayRequestFailed(msg.edgeId, isReason(msg.reason) ? msg.reason : "relay_dial_failed");
    } else if (msg.type === "relay_session_socket" && handle) {
        const reqAdapter = { method: "GET", url: "/", headers: msg.headers, socket: handle };
        acceptRelaySession(
            msg.edgeId,
            reqAdapter as unknown as IncomingMessage,
            handle,
            Buffer.from(msg.head)
        );
    } else if (msg.type === "close_lifeline") {
        closeLifelineLocally(msg.edgeId, msg.reason);
    }
}
