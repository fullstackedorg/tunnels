import net from "node:net";
import type { IncomingMessage } from "node:http";

/**
 * Normalizes an IP address, converting IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) to plain IPv4.
 */
export function normalizeIp(ip: string): string {
    const trimmed = ip.trim();
    if (trimmed.startsWith("::ffff:")) {
        const potentialIpv4 = trimmed.slice(7);
        if (net.isIPv4(potentialIpv4)) {
            return potentialIpv4;
        }
    }
    return trimmed;
}

/**
 * Builds a BlockList containing the provided trusted proxy CIDRs and IP addresses.
 */
export function buildBlockList(trustedProxies: string[]): net.BlockList {
    const blockList = new net.BlockList();
    for (const raw of trustedProxies) {
        const entry = normalizeIp(raw);
        if (!entry) continue;

        if (entry.includes("/")) {
            const [base, prefixStr] = entry.split("/");
            const prefix = parseInt(prefixStr, 10);
            if (Number.isNaN(prefix)) continue;

            const normalizedBase = normalizeIp(base);
            const family = net.isIPv6(normalizedBase) ? "ipv6" : "ipv4";
            blockList.addSubnet(normalizedBase, prefix, family);
        } else {
            const family = net.isIPv6(entry) ? "ipv6" : "ipv4";
            blockList.addAddress(entry, family);
        }
    }
    return blockList;
}

/**
 * Checks whether an IP address is within the trusted proxy list.
 */
export function isTrustedProxy(ip: string, trustedList: net.BlockList): boolean {
    const cleanIp = normalizeIp(ip);
    const family = net.isIPv6(cleanIp) ? "ipv6" : "ipv4";
    try {
        return trustedList.check(cleanIp, family);
    } catch {
        return false;
    }
}

/**
 * Resolves the client IP address from the incoming request and trusted proxy rules:
 * 1. Start from socket remote address.
 * 2. If inside TRUSTED_PROXIES, walk X-Forwarded-For right-to-left skipping trusted proxies.
 * 3. The first untrusted address is the client IP.
 * 4. Normalizes IPv4-mapped IPv6 addresses.
 */
export function resolveClientIp(req: IncomingMessage, trustedProxies: string[] = []): string {
    const rawRemote = req.socket?.remoteAddress || "127.0.0.1";
    const remoteIp = normalizeIp(rawRemote);

    if (trustedProxies.length === 0) {
        return remoteIp;
    }

    const trustedList = buildBlockList(trustedProxies);
    if (!isTrustedProxy(remoteIp, trustedList)) {
        return remoteIp;
    }

    const xff = req.headers["x-forwarded-for"];
    if (!xff) {
        return remoteIp;
    }

    const rawHeader = Array.isArray(xff) ? xff.join(",") : xff;
    const parts = rawHeader
        .split(",")
        .map((p) => normalizeIp(p))
        .filter(Boolean);

    // Walk right-to-left
    for (let i = parts.length - 1; i >= 0; i--) {
        const candidate = parts[i];
        if (!isTrustedProxy(candidate, trustedList)) {
            return candidate;
        }
    }

    return remoteIp;
}
