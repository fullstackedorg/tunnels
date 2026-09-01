import * as http from "node:http";
import * as https from "node:https";
import { pipeline } from "node:stream";
import { type Proxy } from "../entities/schema/proxy.ts";
import { logger } from "../utils/logger.ts";
import { executeHook } from "../utils/hooks.ts";
import type { IncomingMessageWithDeny } from "../http/index.ts";

const Component = "Tunnel Proxy";

export function tunnelProxy(
    req: IncomingMessageWithDeny,
    proxy: Proxy,
    res: http.ServerResponse,
) {
    logger.info(
        Component,
        `Proxying request for [${proxy.name} (${proxy.id})]`,
    );

    const protocol = proxy.urlProtocol;
    const requestModule = protocol === "https" ? https : http;

    const targetHeaders: Record<string, any> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === "authorization") continue;
        targetHeaders[key] = value;
    }

    targetHeaders["host"] =
        proxy.urlHost + (proxy.urlPort ? `:${proxy.urlPort}` : "");

    if (proxy.headers) {
        for (const [key, value] of Object.entries(proxy.headers)) {
            targetHeaders[key.toLowerCase()] = value;
        }
    }

    const options = {
        method: req.method,
        hostname: proxy.urlHost,
        port: proxy.urlPort,
        path: req.url,
        headers: targetHeaders,
    };

    const proxyReq = requestModule.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        pipeline(proxyRes, res, () => {});
    });

    proxyReq.on("error", (err) => {
        logger.error(Component, `Proxy request error: ${err.message}`);
        if (!res.headersSent) {
            res.writeHead(502);
        }
        res.end();
    });

    executeHook("tunnel_proxy", req, proxy, res);

    pipeline(req, proxyReq, () => {});

    logger.info(
        Component,
        `Tunnel Proxy established for [${proxy.name} (${proxy.id})]`,
    );
}
