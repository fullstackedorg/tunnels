import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import crypto from "node:crypto";
import { resolveClientIp } from "../utils/net.ts";

export interface DenyOptions {
    headers?: Record<string, string>;
    fields?: Record<string, string>;
}

export interface IncomingMessageWithDeny extends IncomingMessage {
    id: string;
    clientIp: string;
    correlationId?: string;
    denied: boolean;
    denyReason?: string;
    deny(
        statusCode?: number,
        reason?: string,
        optionsOrHeaders?: Record<string, string> | DenyOptions
    ): void;
}

export function decorateRequest(
    req: IncomingMessage,
    socket: Duplex,
    trustedProxies: string[] = [],
    res?: ServerResponse
): IncomingMessageWithDeny {
    const extendedReq = req as IncomingMessageWithDeny;
    extendedReq.id = crypto.randomUUID();
    extendedReq.clientIp = resolveClientIp(req, trustedProxies);
    const correlation = req.headers["x-request-id"];
    if (correlation) {
        extendedReq.correlationId = Array.isArray(correlation) ? correlation[0] : correlation;
    }
    extendedReq.denied = false;

    extendedReq.deny = (
        statusCode = 403,
        reason = "Denied",
        optionsOrHeaders?: Record<string, string> | DenyOptions
    ) => {
        if (extendedReq.denied) return;
        extendedReq.denied = true;
        extendedReq.denyReason = reason;

        let headers: Record<string, string> = {};
        let fields: Record<string, string> | undefined;

        if (optionsOrHeaders) {
            if ("headers" in optionsOrHeaders || "fields" in optionsOrHeaders) {
                const opt = optionsOrHeaders as DenyOptions;
                headers = opt.headers || {};
                fields = opt.fields;
            } else {
                headers = optionsOrHeaders as Record<string, string>;
            }
        }

        const bodyObj: Record<string, any> = { error: reason };
        if (fields) {
            bodyObj.fields = fields;
        }
        const bodyStr = JSON.stringify(bodyObj);

        if (res && !res.headersSent) {
            res.writeHead(statusCode, {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(bodyStr, "utf-8"),
                ...headers,
            });
            res.end(bodyStr);
        } else if (socket && !socket.destroyed) {
            const statusText = http.STATUS_CODES[statusCode] || "Error";
            const headerLines = [
                `HTTP/1.1 ${statusCode} ${statusText}`,
                "Content-Type: application/json",
                "Connection: close",
                `Content-Length: ${Buffer.byteLength(bodyStr, "utf-8")}`,
            ];
            for (const [k, v] of Object.entries(headers)) {
                headerLines.push(`${k}: ${v}`);
            }
            const rawResponse = headerLines.join("\r\n") + "\r\n\r\n" + bodyStr;
            try {
                socket.write(rawResponse);
                socket.end();
            } catch {
                socket.destroy();
            }
        }
    };

    return extendedReq;
}
