import type http from "node:http";
import type { AppConfig } from "../utils/config.ts";
import { logger } from "../utils/logger.ts";
import { closeStorage } from "../storage/index.ts";
import { closeKV } from "../kv/index.ts";
import { stopHeartbeat } from "../ws/heartbeat.ts";
import { shutdownWarden } from "../warden/index.ts";
import { severAllLocalSessions, getActiveSessionCount } from "../tunnels/registry.ts";

export async function performHubShutdown(
    server: http.Server | null,
    config: AppConfig,
    exitProcess = false
): Promise<number> {
    logger.info("Hub", "Beginning graceful shutdown...");

    // 1. Stop ingress
    if (server) {
        server.close();
    }

    // 2. Fail pending setups and close lifelines with 1001 hub_shutdown
    await shutdownWarden("hub_shutdown");

    // 3. Stop heartbeat sweep
    stopHeartbeat();

    // 3. Drain active sessions up to shutdownTimeout
    let remaining = getActiveSessionCount();
    if (remaining > 0) {
        logger.info(
            "Hub",
            `Draining ${remaining} active session(s) up to ${config.shutdownTimeout}s...`
        );
        const start = Date.now();
        const timeoutMs = config.shutdownTimeout * 1000;

        while (Date.now() - start < timeoutMs && getActiveSessionCount() > 0) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    // 4. Force-close any remaining sessions with 1001 hub_shutdown
    remaining = getActiveSessionCount();
    let exitCode = 0;
    if (remaining > 0) {
        logger.warn("Hub", `Force-closing ${remaining} lingering session(s) with hub_shutdown`);
        severAllLocalSessions("hub_shutdown");
        exitCode = 1;
    }

    // 5. Close storage and KV providers
    await closeStorage();
    await closeKV();

    logger.info("Hub", `Graceful shutdown complete with exit code ${exitCode}`);
    if (exitProcess) {
        process.exit(exitCode);
    }
    return exitCode;
}
