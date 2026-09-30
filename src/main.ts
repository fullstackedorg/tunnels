import { parseConfig } from "./utils/config.ts";
import { logger } from "./utils/logger.ts";
import { loadPlugins } from "./utils/hooks.ts";
import { startHub } from "./hub/index.ts";
import { startEdge } from "./edge/index.ts";

async function main() {
    const config = parseConfig();

    logger.setLogLevel(config.logLevel);
    logger.setLogFormat(config.logFormat);

    if (config.allowFsMultiworker && config.workers > 1) {
        const msg =
            "ALLOW_FILESYSTEM_MULTIWORKER is enabled: file-backed shared storage/KV is for tests only (slow, global file lock, not durable).";
        if (process.env.NODE_ENV === "production") {
            logger.error("Config", msg);
        } else {
            logger.warn("Config", msg);
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
