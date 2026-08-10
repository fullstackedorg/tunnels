import path from "node:path";
import fs from "node:fs";
import { getEnvOrArgCLI } from "../utils/args";
import { KVProvider } from "./interface";

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
        const data = JSON.parse(raw);
        if (
            data !== null &&
            typeof data === "object" &&
            "__kv_value__" in data
        ) {
            if (data.__kv_expires_at__ && Date.now() > data.__kv_expires_at__) {
                fs.promises.unlink(filePath).catch(() => {});
                return null;
            }
            return data.__kv_value__ as T;
        }
        return data as T;
    } catch {
        return null;
    }
}

export async function setFileSystem(
    key: string,
    value: any,
    expiration?: number,
): Promise<void> {
    await fs.promises.mkdir(kvDirectory, { recursive: true });
    const filePath = path.resolve(
        kvDirectory,
        encodeURIComponent(key) + ".json",
    );
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const payload = {
        __kv_value__: value,
        __kv_expires_at__:
            expiration && expiration > 0
                ? Date.now() + expiration * 1000
                : null,
    };
    const data = JSON.stringify(payload);
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

export class FileSystemKVProvider implements KVProvider {
    async get<T = any>(key: string): Promise<T | null> {
        return getFileSystem<T>(key);
    }

    async set(key: string, value: any, expiration?: number): Promise<void> {
        return setFileSystem(key, value, expiration);
    }

    async del(key: string): Promise<void> {
        return delFileSystem(key);
    }
}
