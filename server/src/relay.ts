import cluster from "node:cluster";
import { getEnvOrArgCLI } from "./utils/args.ts";
import { createServerHTTP, stopServerHTTP } from "./http/index.ts";
import { logger } from "./utils/logger.ts";
import { stopWarden, type WardenMessageIPC } from "./warden/index.ts";
import net from "node:net";

let workers: cluster.Worker[] | null = null;

export async function startRelay() {
    const workerCount =
        getEnvOrArgCLI(["WORKERS", "workers", "w"], "number") || 1;

    if (cluster.isWorker || workerCount === 1) {
        if (cluster.isWorker) {
            process.on("disconnect", () => process.exit(0));
        }
        return createServerHTTP();
    }

    workers = new Array(workerCount).fill(null).map(() => cluster.fork());

    cluster.on(
        "message",
        (worker, message: any, socket: net.Socket) => {
            if (!message || typeof message !== "object") return;

            if (message.targetWorkerId) {
                const targetWorker =
                    cluster.workers?.[message.targetWorkerId] ||
                    workers?.find((w) => w.id === message.targetWorkerId);
                if (targetWorker) {
                    targetWorker.send(message, socket);
                }
            }
        },
    );

    cluster.on("exit", (worker, code, signal) => {
        if (workers === null) return;
        const index = workers.indexOf(worker);
        if (index !== -1) {
            logger.info(
                "relay",
                `Worker ${worker.id} exited (code ${code}, signal ${signal}), replacing with new worker`,
            );
            workers[index] = cluster.fork();
        }
    });
}

export async function stopRelay() {
    stopWarden();
    stopServerHTTP();
    workers?.forEach((w) => w.kill());
    workers = null;
}
