import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probe } from "../../../integration/p2p/src/server/healthcheck.ts";
import { P2PClient, type ClientOptions } from "../../../integration/p2p/src/client/index.ts";
import { getAvailablePort, createTempDir, cleanupTempDir } from "../../helpers.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const P2P_DIR = path.resolve(__dirname, "../../../integration/p2p");
const CLIENT_ENTRY = path.join(P2P_DIR, "src/client/index.ts");

export const P2P_CREDENTIALS = {
    rw: { user: "rw", password: "rw-secret" },
    ro: { user: "ro", password: "ro-secret" },
} as const;

export interface P2PServer {
    port: number;
    close: () => Promise<void>;
}

/**
 * Starts the P2P Server from the fullstackedorg/p2p submodule with its CLI entry point and P2P_*
 * environment, the same contract as its Docker image.
 */
export async function startP2PServer(): Promise<P2PServer> {
    const port = await getAvailablePort();
    const dataDir = createTempDir("p2p-");
    const child: ChildProcess = spawn(
        process.execPath,
        [path.join(P2P_DIR, "src/server/main.ts")],
        {
            env: {
                ...process.env,
                P2P_HOST: "127.0.0.1",
                P2P_PORT: String(port),
                P2P_DATA_DIR: dataDir,
                P2P_RW_PASSWORD: P2P_CREDENTIALS.rw.password,
                P2P_RO_PASSWORD: P2P_CREDENTIALS.ro.password,
                P2P_LOG_LEVEL: "warn",
            },
            stdio: ["ignore", "inherit", "inherit"],
        }
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    for (let i = 0; i < 100 && !(await probe("127.0.0.1", port, 500)); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    if (!(await probe("127.0.0.1", port, 500))) {
        child.kill("SIGKILL");
        throw new Error("P2P Server did not start");
    }
    return {
        port,
        close: async () => {
            child.kill("SIGTERM");
            await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
            cleanupTempDir(dataDir);
        },
    };
}

/** A Node.js peer connected straight to the P2P Server (no tunnel). */
export function connectP2P(port: number, options: Partial<ClientOptions> = {}): Promise<P2PClient> {
    return P2PClient.connect({
        host: "127.0.0.1",
        port,
        ...P2P_CREDENTIALS.rw,
        reconnect: false,
        ...options,
    });
}

/** How a runtime script written in `fromDir` imports the P2P client driver. */
export function p2pClientImport(fromDir: string): string {
    const rel = path.relative(fromDir, CLIENT_ENTRY);
    return rel.startsWith(".") ? rel : `./${rel}`;
}

export async function until(check: () => boolean, label: string, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}
