import path from "node:path";
import fs from "node:fs";
import { after } from "node:test";

export async function setupTestServer(port: number) {
    process.env.PORT = port.toString();
    const testDataDir = path.resolve(`./test-data-dir-${port}`);
    process.env.DATA_DIR = testDataDir;
    process.env.QUIET = "1";

    const server = await import("../src/index");
    await server.start();

    after(async () => {
        server.stop();
        await fs.promises.rm(testDataDir, { recursive: true, force: true });
    });

    return {
        PORT: port,
        testDataDir,
        server,
    };
}
