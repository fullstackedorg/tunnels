import path from "node:path";
import { logger, setLogHookDispatcher, type LogEntry } from "./logger.ts";
import { DEFAULT_HOOK_TIMEOUT } from "../constants.ts";

export type HookName =
    | "hub_request"
    | "hub_upgrade"
    | "rest_access"
    | "scope_tunnel"
    | "scope_edge"
    | "create_tunnel"
    | "create_edge"
    | "update_tunnel"
    | "update_edge"
    | "delete_tunnel"
    | "delete_edge"
    | "roll_token_tunnel"
    | "roll_token_edge"
    | "list_tunnel_done"
    | "list_edge_done"
    | "read_tunnel_done"
    | "read_edge_done"
    | "create_tunnel_done"
    | "create_edge_done"
    | "update_tunnel_done"
    | "update_edge_done"
    | "delete_tunnel_done"
    | "delete_edge_done"
    | "roll_token_tunnel_done"
    | "roll_token_edge_done"
    | "tunnel_request"
    | "tunnel_start"
    | "tunnel_connected"
    | "tunnel_end"
    | "lifeline_connect"
    | "lifeline_disconnect"
    | "log"
    | "edge_tunnel_request"
    | "edge_tunnel_start"
    | "edge_tunnel_connected"
    | "edge_tunnel_timeout"
    | "edge_tunnel_end";

const KNOWN_HOOKS = new Set<string>([
    "hub_request",
    "hub_upgrade",
    "rest_access",
    "scope_tunnel",
    "scope_edge",
    "create_tunnel",
    "create_edge",
    "update_tunnel",
    "update_edge",
    "delete_tunnel",
    "delete_edge",
    "roll_token_tunnel",
    "roll_token_edge",
    "list_tunnel_done",
    "list_edge_done",
    "read_tunnel_done",
    "read_edge_done",
    "create_tunnel_done",
    "create_edge_done",
    "update_tunnel_done",
    "update_edge_done",
    "delete_tunnel_done",
    "delete_edge_done",
    "roll_token_tunnel_done",
    "roll_token_edge_done",
    "tunnel_request",
    "tunnel_start",
    "tunnel_connected",
    "tunnel_end",
    "lifeline_connect",
    "lifeline_disconnect",
    "log",
    "edge_tunnel_request",
    "edge_tunnel_start",
    "edge_tunnel_connected",
    "edge_tunnel_timeout",
    "edge_tunnel_end",
]);

type HookHandler = (...args: any[]) => any;

const hookRegistry = new Map<string, HookHandler[]>();

let hookTimeoutMs = DEFAULT_HOOK_TIMEOUT * 1000;

export function setHookTimeout(seconds: number): void {
    hookTimeoutMs = seconds * 1000;
}

export function registerHook(name: HookName | string, handler: HookHandler): () => void {
    if (!KNOWN_HOOKS.has(name)) {
        throw new Error(
            `Unknown hook name: "${name}". Valid hooks are: ${Array.from(KNOWN_HOOKS).join(", ")}`
        );
    }
    const handlers = hookRegistry.get(name) ?? [];
    handlers.push(handler);
    hookRegistry.set(name, handlers);

    return () => {
        const list = hookRegistry.get(name);
        if (list) {
            const idx = list.indexOf(handler);
            if (idx !== -1) list.splice(idx, 1);
        }
    };
}

export function clearHooks(): void {
    hookRegistry.clear();
}

async function runWithTimeout<T>(
    fn: () => Promise<T> | T,
    timeoutMs: number,
    hookName: string
): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Hook "${hookName}" timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });
        return await Promise.race([Promise.resolve(fn()), timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Gating / Scope hooks: sequential, awaited, fail-closed.
 * Checks req.denied / context.denied after each handler.
 */
export async function runGatingHook(
    name: HookName | string,
    context: any,
    ...args: any[]
): Promise<boolean> {
    const handlers = hookRegistry.get(name);
    if (!handlers || handlers.length === 0) return true;

    for (const handler of handlers) {
        if (context?.denied) return false;
        try {
            await runWithTimeout(() => handler(context, ...args), hookTimeoutMs, name);
        } catch (err: any) {
            logger.error("Hooks", `Gating hook "${name}" threw or timed out`, { error: err });
            if (name.startsWith("edge_")) {
                if (context) {
                    context.denied = true;
                    context.denyReason = "hook_error";
                }
            } else if (context?.deny) {
                context.deny(500, "Internal Server Error");
            } else if (context) {
                context.denied = true;
                context.denyReason = "hook_error";
            }
            return false;
        }
        if (context?.denied) return false;
    }
    return !context?.denied;
}

/**
 * Post-query hooks (list_*_done, read_*_done): sequential, awaited, fail-closed.
 */
export async function runPostQueryHook(
    name: HookName | string,
    req: any,
    itemsOrItem: any
): Promise<void> {
    const handlers = hookRegistry.get(name);
    if (!handlers || handlers.length === 0) return;

    for (const handler of handlers) {
        if (req?.denied) return;
        try {
            await runWithTimeout(() => handler(req, itemsOrItem), hookTimeoutMs, name);
        } catch (err: any) {
            logger.error("Hooks", `Post-query hook "${name}" threw or timed out`, { error: err });
            if (req?.deny) {
                req.deny(500, "Internal Server Error");
            } else if (req) {
                req.denied = true;
            }
            return;
        }
        if (req?.denied) return;
    }
}

/**
 * Post-mutation hooks and connected hooks: awaited before continuing, fail-open.
 */
export async function runAwaitedHook(name: HookName | string, ...args: any[]): Promise<void> {
    const handlers = hookRegistry.get(name);
    if (!handlers || handlers.length === 0) return;

    for (const handler of handlers) {
        try {
            await runWithTimeout(() => handler(...args), hookTimeoutMs, name);
        } catch (err: any) {
            logger.error("Hooks", `Awaited hook "${name}" failed`, { error: err });
        }
    }
}

/**
 * Telemetry hooks: un-awaited, fail-open.
 */
export function dispatchTelemetry(name: HookName | string, ...args: any[]): void {
    const handlers = hookRegistry.get(name);
    if (!handlers || handlers.length === 0) return;

    for (const handler of handlers) {
        try {
            const res = handler(...args);
            if (res instanceof Promise) {
                res.catch((err) => {
                    logger.error("Hooks", `Telemetry hook "${name}" rejected`, { error: err });
                });
            }
        } catch (err: any) {
            logger.error("Hooks", `Telemetry hook "${name}" threw`, { error: err });
        }
    }
}

// Connect logger dispatcher
setLogHookDispatcher((entry: LogEntry) => {
    dispatchTelemetry("log", null, entry);
});

/**
 * Dynamically loads plugins specified in --plugin or PLUGINS.
 */
export async function loadPlugins(pluginPaths: string[]): Promise<void> {
    for (const p of pluginPaths) {
        const resolved = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
        try {
            await import(resolved);
            logger.info("Plugin", `Loaded plugin: ${p}`);
        } catch (err: any) {
            logger.error("Plugin", `Failed to load plugin: ${p}`, { error: err });
            throw err;
        }
    }
}
