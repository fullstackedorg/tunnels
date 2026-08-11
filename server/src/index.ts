import { getEnvOrArgCLI } from "./utils/args";
import { logger } from "./utils/logger";

type SERVER_TYPE = "relay" | "connected-to-relay";

let stopProcess: (() => void) | null = null;

export async function start() {
    const serverType: SERVER_TYPE = getEnvOrArgCLI(["RELAY_URL", "relay-url"])
        ? "connected-to-relay"
        : "relay";

    if (serverType === "connected-to-relay") {
        const { connectToRelay, stopConnectToRelay } =
            await import("./connect");
        stopProcess = stopConnectToRelay;
        await connectToRelay();
    } else {
        const { startRelay, stopRelay } = await import("./relay");
        stopProcess = stopRelay;
        await startRelay();
    }

    logger.info("Main", `Server type: ${serverType}`);
}

export function stop() {
    stopProcess?.();
}
