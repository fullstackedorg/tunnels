import cluster, { type Worker } from "node:cluster";
import type { AppConfig } from "../utils/config.ts";
import { logger } from "../utils/logger.ts";
import { EdgeLifeline } from "./lifeline.ts";
import { processEdgeOrder, cancelEdgeOrder, drainAndCloseEdgeSessions } from "./orders.ts";
import type { ConnectTunnelOrder } from "../warden/types.ts";

export type WorkerConnectTunnel = Omit<ConnectTunnelOrder, "connectTimeoutMs"> & {
    deadline: number;
};

/** Primary → worker: the relative budget becomes an absolute deadline (same host clock). */
export function orderToIpc(order: ConnectTunnelOrder, receivedAt: number): WorkerConnectTunnel {
    const { connectTimeoutMs, ...rest } = order;
    return { ...rest, deadline: receivedAt + connectTimeoutMs };
}

/** Worker side: what is left of the budget when the order reaches the worker. */
export function orderFromIpc(msg: WorkerConnectTunnel, now: number): ConnectTunnelOrder {
    const { deadline, ...rest } = msg;
    return { ...rest, connectTimeoutMs: Math.max(0, deadline - now) };
}

interface WorkerLoad {
    id: number;
    pendingCount: number;
    activeCount: number;
}

export function startEdgePrimary(config: AppConfig): void {
    logger.info("Edge", `Starting Edge Primary with ${config.workers} workers`);

    const edgeOrders = new Map<string, { workerId: number; reqId: string }>();
    const activeSessions = new Map<string, number>();
    const workerLoads = new Map<number, WorkerLoad>();

    let lifeline: EdgeLifeline | null = null;

    const getLeastBusyWorker = (): Worker | undefined => {
        let bestWorker: Worker | undefined;
        let minLoad = Infinity;

        for (const [id, load] of workerLoads) {
            const w = cluster.workers?.[id];
            if (!w || !w.isConnected()) continue;
            const total = load.pendingCount + load.activeCount;
            if (total < minLoad) {
                minLoad = total;
                bestWorker = w;
            }
        }
        return bestWorker;
    };

    const forkWorker = () => {
        const worker = cluster.fork({ WORKER_ROLE: "edge" });
        workerLoads.set(worker.id, { id: worker.id, pendingCount: 0, activeCount: 0 });

        worker.on("message", (msg: any) => {
            if (!msg || typeof msg !== "object") return;

            if (msg.type === "order_handoff") {
                const order = edgeOrders.get(msg.ticket);
                if (order) {
                    edgeOrders.delete(msg.ticket);
                    activeSessions.set(msg.ticket, order.workerId);
                    const load = workerLoads.get(order.workerId);
                    if (load) {
                        load.pendingCount = Math.max(0, load.pendingCount - 1);
                        load.activeCount++;
                    }
                }
            } else if (msg.type === "connect_tunnel_failed") {
                edgeOrders.delete(msg.ticket);
                const load = workerLoads.get(worker.id);
                if (load) load.pendingCount = Math.max(0, load.pendingCount - 1);
                lifeline?.sendFailedBeforeHandoff(msg.ticket, msg.reqId, msg.reason);
            } else if (msg.type === "session_ended") {
                const workerId = activeSessions.get(msg.ticket);
                if (workerId) {
                    activeSessions.delete(msg.ticket);
                    const load = workerLoads.get(workerId);
                    if (load) load.activeCount = Math.max(0, load.activeCount - 1);
                }
            }
        });
    };

    for (let i = 0; i < config.workers; i++) {
        forkWorker();
    }

    lifeline = new EdgeLifeline({
        config,
        onRevoked: (timeoutMs, reason) => {
            for (const w of Object.values(cluster.workers || {})) {
                if (w && w.isConnected()) w.send({ type: "drain_sessions", timeoutMs, reason });
            }
        },
        onOrder: (order) => {
            if (order.type === "connect_tunnel") {
                const worker = getLeastBusyWorker();
                if (worker) {
                    edgeOrders.set(order.ticket, { workerId: worker.id, reqId: order.reqId });
                    const load = workerLoads.get(worker.id);
                    if (load) load.pendingCount++;

                    worker.send(orderToIpc(order, Date.now()));
                } else {
                    lifeline?.sendFailedBeforeHandoff(
                        order.ticket,
                        order.reqId,
                        "relay_dial_failed"
                    );
                }
            } else if (order.type === "cancel_tunnel") {
                const pending = edgeOrders.get(order.ticket);
                if (pending) {
                    const worker = cluster.workers?.[pending.workerId];
                    if (worker && worker.isConnected()) {
                        worker.send(order);
                    }
                    edgeOrders.delete(order.ticket);
                    const load = workerLoads.get(pending.workerId);
                    if (load) load.pendingCount = Math.max(0, load.pendingCount - 1);
                }
            }
        },
    });

    lifeline.start();

    let isShuttingDown = false;

    const checkAllExited = () => {
        const alive = Object.values(cluster.workers || {}).filter((w) => w && !w.isDead());
        if (alive.length === 0) {
            process.exit(0);
        }
    };

    cluster.on("exit", (worker) => {
        logger.warn("Edge", `Edge worker ${worker.id} exited`);
        workerLoads.delete(worker.id);

        // Fail pending orders owned by dead worker
        for (const [ticket, order] of edgeOrders.entries()) {
            if (order.workerId === worker.id) {
                edgeOrders.delete(ticket);
                lifeline?.sendFailedBeforeHandoff(ticket, order.reqId, "relay_dial_failed");
            }
        }

        if (!isShuttingDown) {
            forkWorker();
        } else {
            checkAllExited();
        }
    });

    const shutdown = () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        lifeline?.stop().catch(() => {});
        for (const w of Object.values(cluster.workers || {})) {
            if (w && w.isConnected()) {
                w.process.kill("SIGTERM");
            }
        }
        const forceExitTimer = setTimeout(
            () => {
                process.exit(1);
            },
            (config.shutdownTimeout + 5) * 1000
        );
        forceExitTimer.unref();

        checkAllExited();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

export function startEdgeWorker(config: AppConfig): void {
    logger.info("Edge", `Edge worker ${cluster.worker?.id} initialized`);

    process.on("message", (order: any) => {
        if (!order || typeof order !== "object") return;

        if (order.type === "connect_tunnel") {
            processEdgeOrder(orderFromIpc(order, Date.now()), config.hubUrl!, {
                onFailedBeforeHandoff: (ticket, reqId, reason) => {
                    process.send?.({ type: "connect_tunnel_failed", ticket, reqId, reason });
                },
                onHandoff: (ticket) => {
                    process.send?.({ type: "order_handoff", ticket });
                },
                onSessionEnded: (ticket) => {
                    process.send?.({ type: "session_ended", ticket });
                },
            });
        } else if (order.type === "cancel_tunnel") {
            cancelEdgeOrder(order.ticket, order.reason || "client_aborted");
        } else if (order.type === "drain_sessions") {
            drainAndCloseEdgeSessions(order.timeoutMs, order.reason).catch(() => {});
        }
    });

    // The Primary forwards SIGTERM: drain this worker's sessions, then exit.
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        drainAndCloseEdgeSessions(config.shutdownTimeout * 1000, "edge_shutdown")
            .catch(() => {})
            .finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
