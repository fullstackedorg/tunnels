import type { AppConfig } from "./config.ts";

export interface ConfigNotice {
    level: "info" | "warn" | "error";
    message: string;
}

/** Startup log lines required by the Test Mode rules for ALLOW_FILESYSTEM_MULTIWORKER. */
export function configNotices(
    config: AppConfig,
    env: Record<string, string | undefined> = process.env
): ConfigNotice[] {
    if (config.isEdge || !config.allowFsMultiworker) return [];
    if (config.workers <= 1 || (config.postgresUrl && config.redisUrl)) {
        return [
            {
                level: "info",
                message:
                    "ALLOW_FILESYSTEM_MULTIWORKER is ignored: it only applies when WORKERS > 1 without both POSTGRES_URL and REDIS_URL.",
            },
        ];
    }
    return [
        {
            level: env.NODE_ENV === "production" ? "error" : "warn",
            message:
                "ALLOW_FILESYSTEM_MULTIWORKER is enabled: file-backed shared storage/KV is for tests only (slow, global file lock, not durable).",
        },
    ];
}
