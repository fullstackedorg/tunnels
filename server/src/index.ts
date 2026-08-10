import { connectToRelay, stopConnectToRelay } from "./connect";
import { startRelay, stopRelay } from "./relay";
import { getEnvOrArgCLI } from "./utils/args";
import { logger } from "./utils/logger";

type SERVER_TYPE = "relay" | "connected-to-relay";

export async function start() {
    const serverType: SERVER_TYPE = getEnvOrArgCLI(["RELAY_URL", "relay-url"])
        ? "connected-to-relay"
        : "relay";

    if (serverType === "connected-to-relay") {
        await connectToRelay();
    } else {
        await startRelay();
    }

    logger.info("Main", `Server type: ${serverType}`);
}

export function stop() {
    stopRelay();
    stopConnectToRelay();
}
