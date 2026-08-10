import cluster from "node:cluster";
import { getEnvOrArgCLI } from "./utils/args";
import { createServerHTTP, stopServerHTTP } from "./http/index";
import { logger } from "./utils/logger";

let workers: cluster.Worker[] | null = null;

export async function startRelay() {
    const workerCount =
        getEnvOrArgCLI(["WORKERS", "workers", "w"], "number") || 1;

    if (cluster.isWorker || workerCount === 1) {
        return createServerHTTP();
    }

    workers = new Array(workerCount).fill(null).map(() => cluster.fork());

    cluster.on("exit", (worker) => {
        if (workers === null) return;
        const index = workers.indexOf(worker);
        if (index !== -1) {
            logger.info(
                "relay",
                `Worker ${index} exited, replacing with new worker`,
            );
            workers[index] = cluster.fork();
        }
    });
}

export function stopRelay() {
    stopServerHTTP();
    workers?.forEach((w) => w.kill());
    workers = null;
}
