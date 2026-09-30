import { parentPort, workerData } from "node:worker_threads";
import { startHub, type HubInstance } from "../../../src/hub/index.ts";
import { startEdge, type EdgeInstance } from "../../../src/edge/index.ts";
import { parseConfig } from "../../../src/utils/config.ts";

let hub: HubInstance | null = null;
let edge: EdgeInstance | null = null;

const hubConfig = parseConfig([
    "--port",
    String(workerData.hubPort || 0),
    "--data-dir",
    workerData.dataDir,
    "--shutdown-timeout",
    "1",
]);
hub = await startHub(hubConfig);
const actualPort = (hub.server?.address() as any)?.port || workerData.hubPort;
parentPort?.postMessage({ type: "hub_ready", hubPort: actualPort });

parentPort?.on("message", async (msg) => {
    if (msg.type === "start_edge") {
        const edgeConfig = parseConfig([
            "--hub-url",
            `ws://127.0.0.1:${actualPort}`,
            "--token",
            msg.edgeToken,
        ]);
        edge = await startEdge(edgeConfig);
        parentPort?.postMessage({ type: "edge_ready" });
    } else if (msg.type === "close") {
        try {
            if (edge) await edge.stop();
        } catch {}
        try {
            if (hub) await hub.close();
        } catch {}
        parentPort?.postMessage({ type: "closed" });
    }
});
