import cluster from "node:cluster";
import crypto from "node:crypto";
import type http from "node:http";
import type { AppConfig } from "../utils/config.ts";
import { logger } from "../utils/logger.ts";
import { initStorage } from "../storage/index.ts";
import { initKV } from "../kv/index.ts";
import { setHeartbeatConfig } from "../ws/heartbeat.ts";
import { setHookTimeout } from "../utils/hooks.ts";
import { setTunnelConnectTimeout } from "../tunnels/index.ts";
import { setSaturationLimits } from "../warden/orders.ts";
import { setWardenBootId, setWardenClusterIpcSender, handleWardenIpc } from "../warden/index.ts";
import { setTunnelRegistryIpcSender, handleSeverSessionsIpc } from "../tunnels/registry.ts";
import { createHttpServer } from "../http/index.ts";
import { startHubPrimary } from "./cluster.ts";
import { performHubShutdown } from "./shutdown.ts";

export interface HubInstance {
    server: http.Server | null;
    close: () => Promise<number>;
    bootId: string;
}

export async function startHub(config: AppConfig): Promise<HubInstance> {
    if (config.workers > 1 && cluster.isPrimary) {
        startHubPrimary(config);
        return {
            server: null,
            close: async () => {
                return 0;
            },
            bootId: "",
        };
    }

    const bootId = process.env.HUB_BOOT_ID || crypto.randomUUID().slice(0, 8);
    const workerId = cluster.worker ? String(cluster.worker.id) : "1";
    const identity = `${bootId}:${workerId}`;

    logger.setWorkerIdentity(identity);
    setWardenBootId(bootId);

    if (cluster.isWorker) {
        setWardenClusterIpcSender((msg, handle) => {
            if (process.send) process.send(msg, handle);
        });
        setTunnelRegistryIpcSender((msg) => {
            if (process.send) process.send(msg);
        });
        process.on("message", (msg: any, handle: any) => {
            handleWardenIpc(msg, handle);
            handleSeverSessionsIpc(msg);
        });
    }

    // Configure limits and timeouts
    setHeartbeatConfig(config.heartbeatInterval, config.heartbeatTimeout);
    setHookTimeout(config.hookTimeout);
    setTunnelConnectTimeout(config.connectTimeout);
    setSaturationLimits(config.maxPendingOrders, config.maxLifelineBuffer);

    // Initialize data layer
    initKV(config);
    await initStorage(config);

    const server = createHttpServer(config);

    await new Promise<void>((resolve, reject) => {
        server.listen(config.port, config.host, () => {
            logger.info(
                "Hub",
                `Hub listening on http://${config.host}:${config.port} (${identity})`
            );
            resolve();
        });
        server.once("error", reject);
    });

    const instance: HubInstance = {
        server,
        close: async () => {
            return await performHubShutdown(server, config, false);
        },
        bootId,
    };

    if (config.workers === 1) {
        const shutdown = () => {
            instance
                .close()
                .catch(() => {})
                .finally(() => process.exit(0));
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
    }

    return instance;
}
