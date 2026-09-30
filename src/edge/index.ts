import cluster from "node:cluster";
import type { AppConfig } from "../utils/config.ts";
import { logger } from "../utils/logger.ts";
import { EdgeLifeline } from "./lifeline.ts";
import { startEdgePrimary, startEdgeWorker } from "./cluster.ts";

export interface EdgeInstance {
    stop: () => Promise<void>;
}

export async function startEdge(config: AppConfig): Promise<EdgeInstance> {
    if (config.workers > 1) {
        if (cluster.isPrimary) {
            startEdgePrimary(config);
            return {
                stop: async () => {},
            };
        }
        startEdgeWorker(config);
        return {
            stop: async () => {},
        };
    }

    logger.info("Edge", "Starting single-process Edge daemon");
    const lifeline = new EdgeLifeline({ config });
    lifeline.start();

    const instance: EdgeInstance = {
        stop: async () => {
            await lifeline.stop();
        },
    };

    const shutdown = () => {
        instance
            .stop()
            .catch(() => {})
            .finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    return instance;
}
