process.env.TEST = "1";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { after } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.resolve(__dirname, "../tmp");

let fullstackedInstance: any = null;
let stopFullStacked: (() => void) | null = null;

export function stopFullStackedRuntime() {
    if (stopFullStacked) {
        stopFullStacked();
        stopFullStacked = null;
    }
}

try {
    after(() => {
        stopFullStackedRuntime();
    });
} catch {}

export async function getFullStackedRuntime() {
    if (!fullstackedInstance) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
        const nodeMod = (await import(
            "../../../integration/fullstacked/platform/node/src/index.ts" as any
        )) as any;
        stopFullStacked = nodeMod.stop;
        const fsMod = (await import(
            "../../../integration/fullstacked/core/internal/bundle/lib/fullstacked/index.ts" as any
        )) as any;
        fullstackedInstance = fsMod.default || fsMod;
    }
    return fullstackedInstance;
}

export async function runProgrammatic(scriptContent: string): Promise<void> {
    const fullstacked = await getFullStackedRuntime();
    const id = crypto.randomBytes(6).toString("hex");
    const scriptPath = path.join(TMP_DIR, `script-${Date.now()}-${id}.ts`);
    const bundlePath = `${scriptPath}.js`;

    fs.writeFileSync(scriptPath, scriptContent, "utf-8");

    let stderr = "";
    const dummyStderr = {
        write: (msg: string) => {
            stderr += msg;
        },
        writeln: (msg: string) => {
            stderr += msg + "\n";
        },
    };

    const relScriptPath = path.relative(process.cwd(), scriptPath);

    try {
        const exitCode = await fullstacked.execute(["fullstacked", "-f", relScriptPath], {
            stdio: [null, null, dummyStderr],
        });

        if (exitCode !== 0) {
            throw new Error(
                `FullStacked programmatic execution failed (exit code ${exitCode}):\n${stderr}`
            );
        }
    } finally {
        try {
            if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
            if (fs.existsSync(bundlePath)) fs.unlinkSync(bundlePath);
        } catch {}
    }
}

export async function runInBrowser(scriptContent: string): Promise<string> {
    await getFullStackedRuntime();
    const id = crypto.randomBytes(6).toString("hex");
    const appDir = path.join(TMP_DIR, `browser-${Date.now()}-${id}`);
    const entryPath = path.join(appDir, "index.ts");

    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(entryPath, scriptContent, "utf-8");

    const bundleMod = (await import(
        "../../../integration/fullstacked/core/internal/bundle/lib/bundle/index.ts" as any
    )) as any;
    const { createBrowser } = (await import(
        "../../../integration/fullstacked/test/browser.ts" as any
    )) as any;

    const relEntryPath = path.relative(process.cwd(), entryPath);
    const relAppDir = path.relative(process.cwd(), appDir);

    const bundleResult = await bundleMod.default.bundle(relEntryPath);
    if (bundleResult.Errors?.length > 0) {
        throw new Error(`Browser bundling failed: ${JSON.stringify(bundleResult.Errors)}`);
    }

    const browser = await createBrowser(relAppDir);
    try {
        const page = await browser.createPage();
        page.page.on("pageerror", (err: any) => console.error("[BROWSER PAGE ERROR]", err));
        page.page.on("console", (msg: any) => console.log("[BROWSER CONSOLE]", msg.text()));
        await page.page.waitForFunction(
            `document.body.classList.contains("done") || document.body.classList.contains("error")`,
            { timeout: 30000 }
        );

        const hasError = await page.page.evaluate(() => document.body.classList.contains("error"));
        const text = await page.getTextContent("body");

        if (hasError) {
            throw new Error(`In-browser test failed: ${text}`);
        }
        return text;
    } finally {
        await browser.end();
        try {
            fs.rmSync(appDir, { recursive: true, force: true });
        } catch {}
    }
}
