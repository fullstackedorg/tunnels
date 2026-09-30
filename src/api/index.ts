import type { ServerResponse } from "node:http";
import type { IncomingMessageWithDeny } from "../http/deny.ts";
import { runGatingHook } from "../utils/hooks.ts";
import { dispatchBuiltinRoute } from "./routes.ts";
import { sendJson } from "./helpers.ts";

export type RouteHandler = (
    req: IncomingMessageWithDeny,
    res: ServerResponse
) => boolean | Promise<boolean>;

interface RouteRegistration {
    path: string;
    handler: RouteHandler;
    prepend?: boolean;
}

const customRoutes: RouteRegistration[] = [];

export function registerRoute(
    path: string,
    handler: RouteHandler,
    options?: { prepend?: boolean }
): () => void {
    const reg: RouteRegistration = {
        path,
        handler,
        prepend: options?.prepend,
    };
    if (options?.prepend) {
        customRoutes.unshift(reg);
    } else {
        customRoutes.push(reg);
    }

    return () => {
        const idx = customRoutes.indexOf(reg);
        if (idx !== -1) customRoutes.splice(idx, 1);
    };
}

export function clearCustomRoutes(): void {
    customRoutes.length = 0;
}

export async function handleApiRequest(
    req: IncomingMessageWithDeny,
    res: ServerResponse
): Promise<void> {
    const accessPassed = await runGatingHook("rest_access", req);
    if (!accessPassed || req.denied) {
        return;
    }

    const rawPath = (req.url ?? "/").split("?")[0];

    // 1. Prepended custom routes
    for (const r of customRoutes) {
        if (r.prepend && r.path === rawPath) {
            const handled = await r.handler(req, res);
            if (handled) return;
        }
    }

    // 2. Built-in routes
    const builtinHandled = await dispatchBuiltinRoute(req, res);
    if (builtinHandled) return;

    // 3. Appended custom routes
    for (const r of customRoutes) {
        if (!r.prepend && r.path === rawPath) {
            const handled = await r.handler(req, res);
            if (handled) return;
        }
    }

    sendJson(res, 404, { error: "Not Found" });
}
