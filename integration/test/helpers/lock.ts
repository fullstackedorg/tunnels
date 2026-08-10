import path from "node:path";
import fs from "node:fs";
import { threadId } from "node:worker_threads";
import { tmpDir } from "./paths.ts";

export function getProcessIdentifier(): string {
    return `${process.pid}_${threadId}`;
}

export function isRunnerAlive(runnerId: string): boolean {
    if (!runnerId) return false;
    const parts = runnerId.split("_");
    const pid = parseInt(parts[0], 10);
    if (isNaN(pid) || pid <= 0) return false;
    return isPidAlive(pid);
}

export async function acquireLock(
    lockDir: string,
    timeoutMs = 120000,
    retryIntervalMs = 50,
    staleLockMs = 120000
): Promise<() => void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            fs.mkdirSync(tmpDir, { recursive: true });
            fs.mkdirSync(lockDir);
            return () => {
                try {
                    fs.rmSync(lockDir, { recursive: true, force: true });
                } catch { }
            };
        } catch (err: any) {
            if (err.code !== "EEXIST") throw err;
            try {
                const stat = fs.statSync(lockDir);
                if (Date.now() - stat.mtimeMs > staleLockMs) {
                    fs.rmSync(lockDir, { recursive: true, force: true });
                    continue;
                }
            } catch { }
        }
        await new Promise((r) => setTimeout(r, retryIntervalMs));
    }
    throw new Error(`Failed to acquire lock at ${lockDir} within ${timeoutMs}ms`);
}

export function isPidAlive(pid: number): boolean {
    if (!pid || typeof pid !== "number" || pid <= 0) return false;
    try {
        return process.kill(pid, 0);
    } catch {
        return false;
    }
}

export function clearState(stateDir: string): void {
    try {
        const readyFile = path.join(stateDir, ".ready");
        const startingFile = path.join(stateDir, ".starting");
        if (fs.existsSync(readyFile)) fs.unlinkSync(readyFile);
        if (fs.existsSync(startingFile)) fs.unlinkSync(startingFile);
    } catch { }
}

export function getActivePids(pidsDir: string): string[] {
    if (!fs.existsSync(pidsDir)) return [];
    try {
        const files = fs.readdirSync(pidsDir);
        const pids: string[] = [];
        for (const file of files) {
            const filePath = path.join(pidsDir, file);
            let isStale = false;
            try {
                const stat = fs.statSync(filePath);
                if (Date.now() - stat.mtimeMs > 60000) {
                    isStale = true;
                }
            } catch { }

            if (!isStale && isRunnerAlive(file)) {
                pids.push(file);
            } else {
                try {
                    fs.unlinkSync(filePath);
                } catch { }
            }
        }
        return pids;
    } catch {
        return [];
    }
}

export function registerProcess(pidsDir: string): void {
    fs.mkdirSync(pidsDir, { recursive: true });
    const file = path.join(pidsDir, getProcessIdentifier());
    fs.writeFileSync(file, "");
}

export function unregisterProcess(pidsDir: string): void {
    const file = path.join(pidsDir, getProcessIdentifier());
    try {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    } catch { }
}

export interface RunOnceOptions {
    lockDir: string;
    stateDir: string;
    timeoutMs?: number;
    retryIntervalMs?: number;
    isReady?: () => boolean | Promise<boolean>;
}

export async function runOnce(
    options: RunOnceOptions,
    action: () => Promise<void> | void
): Promise<void> {
    const {
        lockDir,
        stateDir,
        timeoutMs = 120000,
        retryIntervalMs = 100,
        isReady
    } = options;

    const readyFile = path.join(stateDir, ".ready");
    fs.mkdirSync(stateDir, { recursive: true });

    const ready = isReady ? await isReady() : fs.existsSync(readyFile);
    if (ready) {
        return;
    }

    const release = await acquireLock(lockDir, timeoutMs, retryIntervalMs);
    try {
        const doubleCheckReady = isReady ? await isReady() : fs.existsSync(readyFile);
        if (doubleCheckReady) {
            return;
        }

        await action();
        fs.writeFileSync(readyFile, "");
    } finally {
        release();
    }
}
