import path from "node:path";
import fs from "node:fs";
import { getEnvOrArgCLI } from "../utils/args";

const dataDirectory =
    getEnvOrArgCLI(["DATA_DIR", "data-dir", "d"], "string") || "data";
const kvDirectory = path.resolve(dataDirectory, "kv");

export async function getFileSystem<T = any>(key: string): Promise<T | null> {
    await fs.promises.mkdir(kvDirectory, { recursive: true });
    const filePath = path.resolve(
        kvDirectory,
        encodeURIComponent(key) + ".json",
    );
    try {
        const raw = await fs.promises.readFile(filePath, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export async function setFileSystem(key: string, value: any): Promise<void> {
    await fs.promises.mkdir(kvDirectory, { recursive: true });
    const filePath = path.resolve(
        kvDirectory,
        encodeURIComponent(key) + ".json",
    );
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const data = JSON.stringify(value);
    await fs.promises.writeFile(tmpPath, data, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
}

export async function delFileSystem(key: string): Promise<void> {
    const filePath = path.resolve(
        kvDirectory,
        encodeURIComponent(key) + ".json",
    );
    try {
        await fs.promises.unlink(filePath);
    } catch {
        // File doesn't exist or already removed
    }
}
