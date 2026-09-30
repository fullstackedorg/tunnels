import crypto from "node:crypto";

export type TokenPrefix = "tun_" | "edg_" | "tmp_";

export function generateToken(prefix: TokenPrefix): string {
    return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

export function getTokenType(token?: string | null): "tunnel" | "edge" | "ticket" | "unknown" {
    if (!token || typeof token !== "string") return "unknown";
    if (token.startsWith("tun_")) return "tunnel";
    if (token.startsWith("edg_")) return "edge";
    if (token.startsWith("tmp_")) return "ticket";
    return "unknown";
}
