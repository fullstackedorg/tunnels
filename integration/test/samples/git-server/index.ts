import git from "fullstacked/git";
import plugin from "fullstacked/plugin";
import fs from "node:fs";
import { readTestFile } from "./test.common.ts";
import { maybeTunnel } from "../tunnel.ts";

const dir = globalThis.testData;
if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
}

const p = await plugin.register("git-auth", {
    callback: () => ({
        username: process.env.USERNAME!,
        password: process.env.PASSWORD!,
    })
})

const ee = await git.clone(
    `http://localhost:${process.env.GIT_SERVER_PORT}/test`,
    dir,
    {
        tunnel: await maybeTunnel(globalThis.tunnel)
    }
)
await ee.promise();
await p.unregister();
globalThis.testResult(readTestFile(dir))