import { logger } from "./logger.ts";
import type { IncomingMessageWithDeny } from "../http/index.ts";

type HookFunction = (
    req: IncomingMessageWithDeny,
    ...args: any[]
) => Promise<void> | void;

const hooks = new Map<string, HookFunction[]>();

export function registerHook(hook: string, func: HookFunction) {
    if (!hooks.has(hook)) {
        hooks.set(hook, []);
    }

    hooks.get(hook)!.push(func);
}

async function executeHookAsync(
    firstPromise: Promise<void>,
    funcs: HookFunction[],
    req: IncomingMessageWithDeny,
    ...args: any[]
) {
    await firstPromise;
    for (const func of funcs) {
        await func(req, ...args);
        if (req.destroyed) {
            return;
        }
    }
}

export function executeHook(
    hook: string,
    req: IncomingMessageWithDeny,
    ...args: any[]
): Promise<void> | void {
    const funcs = hooks.get(hook);
    if (!funcs) {
        return;
    }

    logger.info("Hook", `Executing ${funcs.length} hooks for ${hook}`);
    for (let i = 0; i < funcs.length; i++) {
        const func = funcs[i];
        const maybePromise = func(req, ...args);
        if (maybePromise instanceof Promise) {
            return executeHookAsync(
                maybePromise,
                funcs.slice(i + 1),
                req,
                ...args,
            );
        }
        if (req.destroyed) {
            return;
        }
    }
}
