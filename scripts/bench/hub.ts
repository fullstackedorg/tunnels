/**
 * Hub process for the load bench (scripts/bench/run.ts forks it). Registers no-op hooks shaped
 * like a hosting plugin's (async gating hooks, a byte counter on tunnel_connected, telemetry), so
 * per-connection hook overhead is part of the measurement. Answers "stats" over IPC with its
 * CPU time and memory.
 */
import type { Readable } from "node:stream";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseConfig } from "../../src/utils/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { registerHook } from "../../src/utils/hooks.ts";
import { startHub } from "../../src/hub/index.ts";

const config = parseConfig(process.argv.slice(2));
logger.setLogLevel(config.logLevel);

let bytes = 0;
registerHook("hub_upgrade", async () => {});
registerHook("tunnel_request", async () => {});
registerHook("tunnel_connected", async (_req: unknown, _t: unknown, ...streams: Readable[]) => {
    for (const s of streams) s.on("data", (chunk: Buffer) => (bytes += chunk.length));
});
registerHook("tunnel_start", () => {});
registerHook("tunnel_end", () => {});

const hub = await startHub(config);
const loopDelay = monitorEventLoopDelay({ resolution: 1 });
loopDelay.enable();

process.on("message", (msg: any) => {
    if (msg?.type === "stats") {
        const loop = { p99: loopDelay.percentile(99) / 1e6, max: loopDelay.max / 1e6 };
        if (msg.resetLoop) loopDelay.reset();
        process.send?.({
            type: "stats",
            id: msg.id,
            cpu: process.cpuUsage(),
            mem: process.memoryUsage(),
            bytes,
            loop,
        });
    } else if (msg?.type === "stop") {
        hub.close().finally(() => process.exit(0));
    }
});
process.send?.({ type: "ready", port: (hub.server?.address() as any)?.port });
