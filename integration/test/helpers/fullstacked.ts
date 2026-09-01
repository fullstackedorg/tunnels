import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import { execSync } from "node:child_process";
import assert from "node:assert";
import dotenv from "dotenv";
import type { stop as stopType } from "../../fullstacked/platform/node/src/index.ts";
import fullstacked from "../../fullstacked/core/internal/bundle/lib/fullstacked/index.ts";
import bundler from "../../fullstacked/core/internal/bundle/lib/bundle/index.ts";
import { createBrowser } from "../../fullstacked/test/browser.ts";

import { tmpDir } from "./paths.ts";
import { randomPort } from "./port.ts";
import { acquireLock, getActivePids, registerProcess, unregisterProcess, runOnce, clearState, getProcessIdentifier } from "./lock.ts";

const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const lockDir = path.resolve(tmpDir, ".fullstacked-lock");
const fullstackedDir = path.resolve(tmpDir, ".fullstacked");

let stop: typeof stopType | undefined;

function isFullStackedBuilt(): boolean {
    const bindingNode = path.resolve(currentDirectory, "../../fullstacked/platform/node/bin/binding.node");
    const nodeIndexJs = path.resolve(currentDirectory, "../../fullstacked/platform/node/index.js");
    const tailwindPkg = path.resolve(currentDirectory, "../../fullstacked/node_modules/@fullstacked/tailwindcss/package.json");
    const sassPkg = path.resolve(currentDirectory, "../../fullstacked/node_modules/@fullstacked/sass/package.json");
    return fs.existsSync(bindingNode) && fs.existsSync(nodeIndexJs) && fs.existsSync(tailwindPkg) && fs.existsSync(sassPkg);
}

export async function startFullStacked(timeoutMs = 60000) {
    process.env.PORT = randomPort().toString();

    const release = await acquireLock(lockDir);
    try {
        const activePids = getActivePids(fullstackedDir);
        const currentId = getProcessIdentifier();
        const otherActivePids = activePids.filter((id) => id !== currentId);
        if (otherActivePids.length === 0 && !isFullStackedBuilt()) {
            clearState(fullstackedDir);
        }
        registerProcess(fullstackedDir);
    } finally {
        release();
    }

    await runOnce(
        {
            lockDir,
            stateDir: fullstackedDir,
            timeoutMs,
            isReady: isFullStackedBuilt
        },
        async () => {
            if (isFullStackedBuilt()) return;

            try {
                const fullstackedNodeModules = path.resolve(currentDirectory, "../../fullstacked/node_modules/@fullstacked");
                if (fs.existsSync(fullstackedNodeModules)) {
                    fs.rmSync(fullstackedNodeModules, { recursive: true, force: true });
                }
            } catch { }

            try {
                execSync(`node --experimental-strip-types "${path.resolve(currentDirectory, "../../fullstacked/build.ts")}"`, {
                    stdio: "inherit",
                    cwd: path.resolve(currentDirectory, "../../fullstacked")
                });
            } catch (err) {
                console.error("FullStacked build.ts output error:", err);
            }

            try {
                execSync(`node --experimental-strip-types "${path.resolve(currentDirectory, "../../fullstacked/platform/node/build.ts")}"`, {
                    stdio: "inherit",
                    cwd: path.resolve(currentDirectory, "../../fullstacked/platform/node")
                });
            } catch (err) {
                console.error("FullStacked platform/node/build.ts output error:", err);
            }
        }
    );

    stop = (await import("../../fullstacked/platform/node/src/index.ts")).stop;
    console.log("FullStacked Ready");
}

export async function stopFullStacked() {
    stop?.();
    stop = undefined;

    const release = await acquireLock(lockDir);
    try {
        unregisterProcess(fullstackedDir);
        const remainingPids = getActivePids(fullstackedDir);

        if (remainingPids.length > 0) {
            console.log(`Skipping FullStacked global state cleanup, ${remainingPids.length} test runner(s) still active (PIDs: ${remainingPids.join(", ")})`);
            return;
        }

        try {
            if (fs.existsSync(fullstackedDir)) {
                fs.rmSync(fullstackedDir, { recursive: true, force: true });
            }
        } catch { }
    } finally {
        release();
    }
}

export async function runTestWithFullStacked(sampleDir: string, testData?: any) {
    globalThis.testData = testData;
    let result: any;
    globalThis.testResult = (res) => {
        result = res;
    };
    await fullstacked.execute(`fullstacked -f ${path.join(sampleDir, "index.ts")}`);
    delete globalThis.tunnel;
    delete globalThis.proxy;
    return result;
}

export async function runTestWithFullStackedInBrowser(sampleDir: string, testData?: any) {
    process.env.TEST = "1";
    const build = await bundler.bundle(sampleDir);
    assert.strictEqual(build.Errors, null);
    assert.strictEqual(build.Warnings, null);

    const testEnvPath = path.resolve(currentDirectory, "../test-env");
    const testEnv = fs.existsSync(testEnvPath)
        ? dotenv.parse(fs.readFileSync(testEnvPath))
        : fs.existsSync("test-env")
            ? dotenv.parse(fs.readFileSync("test-env"))
            : {};

    const browser = await createBrowser(sampleDir, testEnv);
    const page = await browser.browser.newPage();
    page.on("console", (msg) => console.log("[BROWSER]", msg.text()));
    page.on("pageerror", (err) => console.log("[BROWSER]", err));
    page.on("error", (err) => console.log("[BROWSER]", err));
    page.on("response", (response) => {
        if (response.status() >= 400) {
            console.log(`[BROWSER HTTP ${response.status()}] ${response.request().method()} ${response.url()}`);
        }
    });
    page.on("requestfailed", (request) => {
        console.log(`[BROWSER Request Failed] ${request.method()} ${request.url()} - ${request.failure()?.errorText || "failed"}`);
    });
    const result = await Promise.race([
        new Promise(async (resolve, reject) => {
            page.once("error", reject);
            page.once("pageerror", reject);
            await page.exposeFunction("testResult", async (result: any) => {
                resolve(result);
            });
            await page.evaluateOnNewDocument((d, t, p) => {
                globalThis.tunnel = t;
                globalThis.proxy = p;
                globalThis.testData = d;
            }, testData, globalThis.tunnel, globalThis.proxy);
            await page.goto(`http://localhost:${browser.webview.port}`);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Browser test timeout after 8s")), 8000))
    ]);
    await browser.end();
    delete globalThis.tunnel;
    delete globalThis.proxy;
    return result;
}