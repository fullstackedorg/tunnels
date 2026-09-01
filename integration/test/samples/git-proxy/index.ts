import git from "fullstacked/git";
import fs from "node:fs";
import { readTestFile } from "../git-server/test.common.ts";

const dir = globalThis.testData;
if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
}

const ee = await git.clone(
    `http://localhost/test`,
    dir,
    {
        proxy: globalThis.proxy
    }
)
await ee.promise();
globalThis.testResult(readTestFile(dir))