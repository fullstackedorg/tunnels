import type { Duplex } from "node:stream";
import { registerHook } from "../server/src/utils/hooks.ts";
import { logger } from "../server/src/utils/logger.ts";

/**
 * Plugin: per-session and per-process byte accounting.
 *
 * Load with: node server/src/main.ts --plugin ./examples/track-bandwidth-hook.ts
 *
 * Hooks are registered when this module is imported. The Hub fires tunnel_connected and the
 * Edge fires edge_tunnel_connected; each runs before the streams resume, so every byte is seen.
 * Totals are per process: with WORKERS > 1, each worker keeps its own totals.
 */

let totalIngressBytes = 0; // runtime -> target
let totalEgressBytes = 0;  // target -> runtime

function track(label: string, name: string, remoteSocket: Duplex, targetSocket: Duplex) {
  let ingress = 0;
  let egress = 0;
  let reported = false;

  const onReport = () => {
    if (reported) return;
    reported = true;
    logger.info("Bandwidth", `${label} ${name}: ingress ${ingress} B, egress ${egress} B`, {
      totalIngressBytes,
      totalEgressBytes,
    });
  };

  remoteSocket.on("data", (chunk: Buffer) => {
    ingress += chunk.length;
    totalIngressBytes += chunk.length;
  });

  targetSocket.on("data", (chunk: Buffer) => {
    egress += chunk.length;
    totalEgressBytes += chunk.length;
  });

  remoteSocket.once("close", onReport);
  targetSocket.once("close", onReport);
}

// Hub
registerHook("tunnel_connected", (_req, tunnel, remoteSocket, targetSocket) => {
  track("tunnel", tunnel.name, remoteSocket as Duplex, targetSocket as Duplex);
});

// Edge
registerHook("edge_tunnel_connected", (_context, tunnel, remoteSocket, targetSocket) => {
  track("edge tunnel", tunnel.name, remoteSocket as Duplex, targetSocket as Duplex);
});

