import { logger } from "./logger.ts";
import type { IncomingMessageWithDeny } from "../http/index.ts";

export type HookFunction<T = IncomingMessageWithDeny> = (
    req: T,
    ...args: any[]
) => Promise<void> | void;

const hooks = new Map<string, HookFunction<any>[]>();

export function registerHook<T = IncomingMessageWithDeny>(
    hook: string,
    func: HookFunction<T>,
): () => void {
    if (!hooks.has(hook)) {
        hooks.set(hook, []);
    }

    hooks.get(hook)!.push(func as HookFunction<any>);

    return () => {
        removeHook(hook, func as HookFunction<any>);
    };
}

export function removeHook(hook: string, func: HookFunction<any>) {
    const list = hooks.get(hook);
    if (!list) return;
    const index = list.indexOf(func);
    if (index !== -1) {
        list.splice(index, 1);
    }
    if (list.length === 0) {
        hooks.delete(hook);
    }
}

const SYSTEM_HOOKS = new Set(["get_machines"]);

export function clearHooks(hook?: string) {
    if (hook) {
        hooks.delete(hook);
    } else {
        for (const key of Array.from(hooks.keys())) {
            if (!SYSTEM_HOOKS.has(key)) {
                hooks.delete(key);
            }
        }
    }
}

function handleHookError(hook: string, err: any) {
    const errorMsg = `Error in hook [${hook}]: ${err?.message || err}`;
    if (hook !== "log") {
        logger.error("Hook", errorMsg, err);
    } else {
        console.error(`[${new Date().toISOString()}] [Hook] ${errorMsg}`, err);
    }
}

async function executeHookAsync(
    firstPromise: Promise<void>,
    funcs: HookFunction<any>[],
    req: IncomingMessageWithDeny | null,
    hook: string,
    ...args: any[]
) {
    try {
        await firstPromise;
    } catch (err: any) {
        handleHookError(hook, err);
    }
    for (const func of funcs) {
        try {
            await func(req, ...args);
        } catch (err: any) {
            handleHookError(hook, err);
        }
        if (req?.destroyed) {
            return;
        }
    }
}

export function executeHook(
    hook: string,
    req: IncomingMessageWithDeny | null,
    ...args: any[]
): Promise<void> | void {
    const funcs = hooks.get(hook);
    if (!funcs) {
        return;
    }

    if (hook !== "log") {
        logger.info("Hook", `Executing ${funcs.length} hooks for ${hook}`);
    }
    for (let i = 0; i < funcs.length; i++) {
        const func = funcs[i];
        try {
            const maybePromise = func(req, ...args);
            if (maybePromise instanceof Promise) {
                return executeHookAsync(
                    maybePromise,
                    funcs.slice(i + 1),
                    req,
                    hook,
                    ...args,
                );
            }
        } catch (err: any) {
            handleHookError(hook, err);
        }
        if (req?.destroyed) {
            return;
        }
    }
}
