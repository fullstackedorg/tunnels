import cluster from "node:cluster";
import { parseConfig } from "./utils/config.ts";
import { configNotices } from "./utils/config-notices.ts";
import { logger } from "./utils/logger.ts";
import { loadPlugins } from "./utils/hooks.ts";
import { startHub } from "./hub/index.ts";
import { startEdge } from "./edge/index.ts";

async function main() {
    const config = parseConfig();

    logger.setLogLevel(config.logLevel);
    logger.setLogFormat(config.logFormat);

    if (cluster.isPrimary) {
        for (const notice of configNotices(config)) {
            logger[notice.level]("Config", notice.message);
        }
    }

    if (config.plugins.length > 0) {
        await loadPlugins(config.plugins);
    }

    if (config.isEdge) {
        await startEdge(config);
    } else {
        await startHub(config);
    }
}

main().catch((err) => {
    process.stderr.write(`Fatal startup error: ${err?.message || err}\n`);
    process.exit(1);
});
