import cluster, { type Worker } from "node:cluster";
import type { AppConfig } from "../utils/config.ts";
import { logger } from "../utils/logger.ts";
import { EdgeLifeline } from "./lifeline.ts";
import { drainAndCloseEdgeSessions } from "./streams.ts";
import { closeRelaySessions, openRelaySession } from "./relay.ts";

/**
 * Multi-worker Edge: the Primary holds the lifeline, workers hold relay sessions and serve their
 * streams. Each `open_relay` order goes to the worker with the fewest relay sessions.
 */
export function startEdgePrimary(config: AppConfig): void {
    logger.info("Edge", `Starting Edge Primary with ${config.workers} workers`);

    const relayCounts = new Map<number, number>();
    let lifeline: EdgeLifeline | null = null;

    const leastLoadedWorker = (): Worker | undefined => {
        let best: Worker | undefined;
        let fewest = Infinity;
        for (const [id, count] of relayCounts) {
            const w = cluster.workers?.[id];
            if (!w || !w.isConnected()) continue;
            if (count < fewest) {
                fewest = count;
                best = w;
            }
        }
        return best;
    };

    const forkWorker = () => {
        const worker = cluster.fork({ WORKER_ROLE: "edge" });
        relayCounts.set(worker.id, 0);

        worker.on("message", (msg: any) => {
            if (!msg || typeof msg !== "object") return;
            const count = relayCounts.get(worker.id) ?? 0;
            if (msg.type === "relay_opened") {
                relayCounts.set(worker.id, count + 1);
            } else if (msg.type === "relay_closed") {
                relayCounts.set(worker.id, Math.max(0, count - 1));
            } else if (msg.type === "open_relay_failed") {
                lifeline?.sendRelayFailed(msg.worker);
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
            if (order.type !== "open_relay" || typeof order.worker !== "string") return;
            const worker = leastLoadedWorker();
            if (worker) worker.send(order);
            else lifeline?.sendRelayFailed(order.worker);
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
        // Its relay sessions dropped with it; the Hub asks for new ones as streams need them.
        relayCounts.delete(worker.id);

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

        if (order.type === "open_relay") {
            openRelaySession(config, order.worker, () => {
                process.send?.({ type: "relay_closed" });
            }).then((ok) => {
                process.send?.(
                    ok
                        ? { type: "relay_opened" }
                        : { type: "open_relay_failed", worker: order.worker }
                );
            });
        } else if (order.type === "drain_sessions") {
            drainAndCloseEdgeSessions(order.timeoutMs, order.reason)
                .catch(() => {})
                .finally(() => closeRelaySessions(order.reason));
        }
    });

    // The Primary forwards SIGTERM: drain this worker's streams, then exit.
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        drainAndCloseEdgeSessions(config.shutdownTimeout * 1000, "edge_shutdown")
            .catch(() => {})
            .finally(() => {
                closeRelaySessions("edge_shutdown");
                process.exit(0);
            });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
