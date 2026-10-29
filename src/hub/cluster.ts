import cluster from "node:cluster";
import crypto from "node:crypto";
import type { AppConfig } from "../utils/config.ts";
import { logger } from "../utils/logger.ts";
import { initKV, type KVProvider } from "../kv/index.ts";

export interface ClusterState {
    bootId: string;
    isShuttingDown: boolean;
}

/** Removes the presence a dead worker still owns; never touches newer mappings. */
export async function cleanupWorkerPresence(kv: KVProvider, identity: string): Promise<void> {
    const edgeIds = await kv.smembers(`worker:${identity}:edges`);
    for (const edgeId of edgeIds) {
        await kv.delIfEquals(`edge:${edgeId}:worker`, identity);
    }
    await kv.del(`worker:${identity}:edges`);
}

export function startHubPrimary(
    config: AppConfig,
    bootId: string = crypto.randomUUID().slice(0, 8)
): void {
    logger.info(
        "Hub",
        `Starting Hub Primary in clustered mode (bootId: ${bootId}, workers: ${config.workers})`
    );

    const state: ClusterState = {
        bootId,
        isShuttingDown: false,
    };
    logger.setWorkerIdentity(`${bootId}:primary`);
    // Same provider as the workers (Redis or shared file KV) so cleanup sees their presence.
    const kv = initKV(config);
    let exitCode = 0;

    cluster.setupPrimary({
        serialization: "advanced",
    });

    const forkWorker = () => {
        const worker = cluster.fork({
            HUB_BOOT_ID: bootId,
            WORKER_ROLE: "hub",
        });

        worker.on("message", (msg: any, handle: any) => {
            if (!msg || typeof msg !== "object") return;

            // Broadcast sever_sessions to all workers
            if (msg.type === "sever_sessions") {
                for (const w of Object.values(cluster.workers || {})) {
                    if (w && w.isConnected()) {
                        w.send(msg);
                    }
                }
                return;
            }

            // Target-directed message
            const targetIdentity = msg.target;
            if (!targetIdentity) return;
            const targetWorkerId = targetIdentity.split(":")[1];
            const targetWorker = cluster.workers?.[targetWorkerId];

            if (targetWorker && targetWorker.isConnected()) {
                targetWorker.send(msg, handle);
            } else {
                // Dead worker recovery
                if (handle && typeof handle.destroy === "function") {
                    handle.destroy();
                }
                if (msg.type === "relay_request") {
                    // Lifeline worker dead: the worker that asked for a relay session stops waiting
                    const askingWorker = cluster.workers?.[msg.worker?.split(":")[1]];
                    if (askingWorker && askingWorker.isConnected()) {
                        askingWorker.send({
                            type: "relay_failed",
                            target: msg.worker,
                            edgeId: msg.edgeId,
                            reason: "target_worker_dead",
                        });
                    }
                }
            }
        });
    };

    for (let i = 0; i < config.workers; i++) {
        forkWorker();
    }

    const checkAllExited = () => {
        const alive = Object.values(cluster.workers || {}).filter((w) => w && !w.isDead());
        if (alive.length === 0) {
            process.exit(exitCode);
        }
    };

    cluster.on("exit", async (worker, code, signal) => {
        const identity = `${bootId}:${worker.id}`;
        if (state.isShuttingDown) {
            if (code !== 0) exitCode = 1;
            logger.info("Hub", `Worker ${identity} exited (code: ${code}, signal: ${signal})`);
        } else {
            logger.warn("Hub", `Worker ${identity} exited (code: ${code}, signal: ${signal})`);
        }

        try {
            await cleanupWorkerPresence(kv, identity);
        } catch (err: any) {
            logger.warn("Hub", `Failed to clean presence for worker ${identity}: ${err?.message}`);
        }

        if (!state.isShuttingDown) {
            logger.info("Hub", `Forking replacement worker for ${identity}`);
            forkWorker();
        } else {
            checkAllExited();
        }
    });

    const shutdown = () => {
        if (state.isShuttingDown) return;
        state.isShuttingDown = true;
        logger.info("Hub", "Primary received shutdown signal, notifying workers...");

        for (const w of Object.values(cluster.workers || {})) {
            if (w && w.isConnected()) {
                w.process.kill("SIGTERM");
            }
        }

        const forceExitTimer = setTimeout(
            () => {
                logger.error("Hub", "Workers did not exit in time; exiting");
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
