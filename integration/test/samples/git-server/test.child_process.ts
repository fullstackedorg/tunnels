import child_process from "node:child_process";
import fs from "node:fs";
import { readTestFile } from "./test.common";

export async function testGitServer(
    port: number,
    user: string,
    password: string,
    dir: string
) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    child_process.execSync(`git clone http://${user}:${password}@localhost:${port}/test "${dir}"`, { stdio: "pipe" });
    return readTestFile(dir);
}

