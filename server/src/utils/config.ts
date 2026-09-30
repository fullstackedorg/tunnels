import {
    DEFAULT_PORT,
    DEFAULT_HOST,
    DEFAULT_HEARTBEAT_INTERVAL,
    DEFAULT_HEARTBEAT_TIMEOUT,
    DEFAULT_HOOK_TIMEOUT,
    DEFAULT_CONNECT_TIMEOUT,
    DEFAULT_SHUTDOWN_TIMEOUT,
    DEFAULT_DRAIN_TIMEOUT,
    DEFAULT_REVOKED_POLL_INTERVAL,
    DEFAULT_ENTITY_CACHE_TTL,
    DEFAULT_NEGATIVE_CACHE_TTL,
    DEFAULT_MAX_PENDING_ORDERS,
    DEFAULT_MAX_LIFELINE_BUFFER,
    DEFAULT_DATA_DIR,
    DEFAULT_WORKERS,
    DEFAULT_RECONNECT_INTERVAL,
    DEFAULT_MAX_RECONNECT_INTERVAL,
} from "../constants.ts";

export interface AppConfig {
    isEdge: boolean;
    workers: number;
    heartbeatInterval: number;
    heartbeatTimeout: number;
    hookTimeout: number;
    shutdownTimeout: number;
    plugins: string[];
    logLevel: "debug" | "info" | "warn" | "error";
    logFormat: "text" | "json";
    quiet: boolean;

    // Hub settings
    port: number;
    host: string;
    postgresUrl?: string;
    redisUrl?: string;
    dataDir: string;
    allowFsMultiworker: boolean;
    connectTimeout: number;
    trustedProxies: string[];
    entityCacheTtl: number;
    negativeCacheTtl: number;
    maxPendingOrders: number;
    maxLifelineBuffer: number;

    // Edge settings
    hubUrl?: string;
    token?: string;
    tokenFile?: string;
    reconnectInterval: number;
    maxReconnectInterval: number;
    drainTimeout: number;
    revokedPollInterval: number;
}

function parseCliArgs(args: string[]): Record<string, string | boolean> {
    const parsed: Record<string, string | boolean> = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith("-")) continue;

        if (arg.includes("=")) {
            const [rawKey, ...rest] = arg.split("=");
            const key = rawKey.replace(/^-+/, "");
            parsed[key] = rest.join("=");
        } else {
            const key = arg.replace(/^-+/, "");
            const next = args[i + 1];
            if (next !== undefined && !next.startsWith("-")) {
                parsed[key] = next;
                i++;
            } else {
                parsed[key] = true;
            }
        }
    }
    return parsed;
}

function getVal<T>(
    cliKeys: string[],
    envKeys: string[],
    cli: Record<string, string | boolean>,
    env: Record<string, string | undefined>,
    transform: (v: string | boolean) => T,
    defaultValue: T
): T {
    for (const k of cliKeys) {
        if (cli[k] !== undefined) return transform(cli[k]);
    }
    for (const k of envKeys) {
        if (env[k] !== undefined && env[k] !== "") return transform(env[k]!);
    }
    return defaultValue;
}

export function parseConfig(
    argv: string[] = process.argv.slice(2),
    env: Record<string, string | undefined> = process.env
): AppConfig {
    const cli = parseCliArgs(argv);

    const hubUrl = getVal(["hub-url"], ["HUB_URL"], cli, env, String, undefined);
    const isEdge = Boolean(hubUrl);

    const quiet = getVal(
        ["quiet", "q"],
        ["QUIET"],
        cli,
        env,
        (v) => v === true || v === "true" || v === "1",
        false
    );
    let logLevel = getVal(
        ["log-level"],
        ["LOG_LEVEL"],
        cli,
        env,
        (v) => String(v).toLowerCase() as any,
        "info"
    );
    if (quiet) logLevel = "warn";

    const config: AppConfig = {
        isEdge,
        workers: getVal(["workers", "w"], ["WORKERS"], cli, env, Number, DEFAULT_WORKERS),
        heartbeatInterval: getVal(
            ["heartbeat-interval"],
            ["HEARTBEAT_INTERVAL"],
            cli,
            env,
            Number,
            DEFAULT_HEARTBEAT_INTERVAL
        ),
        heartbeatTimeout: getVal(
            ["heartbeat-timeout"],
            ["HEARTBEAT_TIMEOUT"],
            cli,
            env,
            Number,
            DEFAULT_HEARTBEAT_TIMEOUT
        ),
        hookTimeout: getVal(
            ["hook-timeout"],
            ["HOOK_TIMEOUT"],
            cli,
            env,
            Number,
            DEFAULT_HOOK_TIMEOUT
        ),
        shutdownTimeout: getVal(
            ["shutdown-timeout"],
            ["SHUTDOWN_TIMEOUT"],
            cli,
            env,
            Number,
            DEFAULT_SHUTDOWN_TIMEOUT
        ),
        plugins: getVal(
            ["plugin"],
            ["PLUGINS"],
            cli,
            env,
            (v) =>
                String(v)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
            []
        ),
        logLevel,
        logFormat: getVal(
            ["log-format"],
            ["LOG_FORMAT"],
            cli,
            env,
            (v) => String(v).toLowerCase() as any,
            "text"
        ),
        quiet,

        port: getVal(["port", "p"], ["PORT"], cli, env, Number, DEFAULT_PORT),
        host: getVal(["host"], ["HOST"], cli, env, String, DEFAULT_HOST),
        postgresUrl: getVal(["postgres-url"], ["POSTGRES_URL"], cli, env, String, undefined),
        redisUrl: getVal(["redis-url"], ["REDIS_URL"], cli, env, String, undefined),
        dataDir: getVal(["data-dir", "d"], ["DATA_DIR"], cli, env, String, DEFAULT_DATA_DIR),
        allowFsMultiworker: getVal(
            ["allow-fs-multiworker", "allow-filesystem-multiworker"],
            ["ALLOW_FILESYSTEM_MULTIWORKER"],
            cli,
            env,
            (v) => v === true || v === "true" || v === "1",
            false
        ),
        connectTimeout: getVal(
            ["connect-timeout"],
            ["CONNECT_TIMEOUT"],
            cli,
            env,
            Number,
            DEFAULT_CONNECT_TIMEOUT
        ),
        trustedProxies: getVal(
            ["trusted-proxies"],
            ["TRUSTED_PROXIES"],
            cli,
            env,
            (v) =>
                String(v)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
            []
        ),
        entityCacheTtl: getVal(
            ["entity-cache-ttl"],
            ["ENTITY_CACHE_TTL"],
            cli,
            env,
            Number,
            DEFAULT_ENTITY_CACHE_TTL
        ),
        negativeCacheTtl: getVal(
            ["negative-cache-ttl"],
            ["NEGATIVE_CACHE_TTL"],
            cli,
            env,
            Number,
            DEFAULT_NEGATIVE_CACHE_TTL
        ),
        maxPendingOrders: getVal(
            ["max-pending-orders"],
            ["MAX_PENDING_ORDERS"],
            cli,
            env,
            Number,
            DEFAULT_MAX_PENDING_ORDERS
        ),
        maxLifelineBuffer: getVal(
            ["max-lifeline-buffer"],
            ["MAX_LIFELINE_BUFFER"],
            cli,
            env,
            Number,
            DEFAULT_MAX_LIFELINE_BUFFER
        ),

        hubUrl,
        token: getVal(["token"], ["TOKEN"], cli, env, String, undefined),
        tokenFile: getVal(["token-file"], ["TOKEN_FILE"], cli, env, String, undefined),
        reconnectInterval: getVal(
            ["reconnect-interval"],
            ["RECONNECT_INTERVAL"],
            cli,
            env,
            Number,
            DEFAULT_RECONNECT_INTERVAL
        ),
        maxReconnectInterval: getVal(
            ["max-reconnect-interval"],
            ["MAX_RECONNECT_INTERVAL"],
            cli,
            env,
            Number,
            DEFAULT_MAX_RECONNECT_INTERVAL
        ),
        drainTimeout: getVal(
            ["drain-timeout"],
            ["DRAIN_TIMEOUT"],
            cli,
            env,
            Number,
            DEFAULT_DRAIN_TIMEOUT
        ),
        revokedPollInterval: getVal(
            ["revoked-poll-interval"],
            ["REVOKED_POLL_INTERVAL"],
            cli,
            env,
            Number,
            DEFAULT_REVOKED_POLL_INTERVAL
        ),
    };

    validateConfig(config, env);
    return config;
}

function validateConfig(config: AppConfig, env: Record<string, string | undefined>): void {
    if (config.isEdge) {
        if (!config.token && !config.tokenFile) {
            throw new Error(
                "Startup error: Edge mode requires either --token / TOKEN or --token-file / TOKEN_FILE."
            );
        }
    } else if (config.workers > 1) {
        const hasDbAndCache = Boolean(config.postgresUrl && config.redisUrl);
        if (!hasDbAndCache && !config.allowFsMultiworker) {
            throw new Error(
                "Startup error: WORKERS > 1 requires PostgreSQL (POSTGRES_URL) and Redis (REDIS_URL), or ALLOW_FILESYSTEM_MULTIWORKER for tests."
            );
        }
    }
}
