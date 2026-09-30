import { parseConfig, type AppConfig } from "./utils/config.ts";
import { logger } from "./utils/logger.ts";
import { storage } from "./storage/index.ts";
import { kv } from "./kv/index.ts";
import { registerHook } from "./utils/hooks.ts";
import { registerRoute } from "./api/index.ts";
import { registerWebSocketRoute } from "./http/index.ts";
import { severSessions } from "./tunnels/registry.ts";
import { startHub, type HubInstance } from "./hub/index.ts";
import { startEdge, type EdgeInstance } from "./edge/index.ts";

export { storage } from "./storage/index.ts";
export { kv } from "./kv/index.ts";
export { logger } from "./utils/logger.ts";
export { registerHook } from "./utils/hooks.ts";
export { registerRoute } from "./api/index.ts";
export { registerWebSocketRoute } from "./http/index.ts";
export { severSessions } from "./tunnels/registry.ts";
export { parseConfig } from "./utils/config.ts";

export type { AppConfig } from "./utils/config.ts";
export type { Reason } from "./constants.ts";
export type { Tunnel, Edge } from "./entities/schema.ts";

let currentHub: HubInstance | null = null;
let currentEdge: EdgeInstance | null = null;

export async function start(
    customConfig?: Partial<AppConfig>
): Promise<HubInstance | EdgeInstance> {
    const baseConfig = parseConfig([]);
    const config: AppConfig = { ...baseConfig, ...(customConfig || {}) };

    logger.setLogLevel(config.logLevel);
    logger.setLogFormat(config.logFormat);

    if (config.isEdge) {
        currentEdge = await startEdge(config);
        return currentEdge;
    }
    currentHub = await startHub(config);
    return currentHub;
}

export async function stop(): Promise<void> {
    if (currentHub) {
        await currentHub.close();
        currentHub = null;
    }
    if (currentEdge) {
        await currentEdge.stop();
        currentEdge = null;
    }
}
