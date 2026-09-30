import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { IncomingMessage } from "node:http";
import { normalizeIp, buildBlockList, isTrustedProxy, resolveClientIp } from "../src/utils/net.ts";
import { generateToken, getTokenType } from "../src/utils/token.ts";

test("net: normalizeIp converts IPv4-mapped IPv6 addresses", () => {
    assert.strictEqual(normalizeIp("::ffff:192.168.1.1"), "192.168.1.1");
    assert.strictEqual(normalizeIp("127.0.0.1"), "127.0.0.1");
    assert.strictEqual(normalizeIp("::1"), "::1");
    assert.strictEqual(normalizeIp("   10.0.0.1  "), "10.0.0.1");
    assert.strictEqual(normalizeIp("::ffff:invalid"), "::ffff:invalid");
});

test("net: buildBlockList and isTrustedProxy handle CIDR and single IPs", () => {
    const list = buildBlockList(["10.0.0.0/8", "192.168.1.50", "::1", "invalid/notanumber", ""]);
    assert.strictEqual(isTrustedProxy("10.5.5.5", list), true);
    assert.strictEqual(isTrustedProxy("10.255.255.255", list), true);
    assert.strictEqual(isTrustedProxy("192.168.1.50", list), true);
    assert.strictEqual(isTrustedProxy("192.168.1.51", list), false);
    assert.strictEqual(isTrustedProxy("::1", list), true);
    assert.strictEqual(isTrustedProxy("8.8.8.8", list), false);
    assert.strictEqual(isTrustedProxy("::ffff:10.1.2.3", list), true);
});

test("net: resolveClientIp extracts correct client IP based on trusted proxies", () => {
    // 1. Without trusted proxies, always returns socket remote address
    const reqNoProxies = {
        socket: { remoteAddress: "10.0.0.1" } as net.Socket,
        headers: { "x-forwarded-for": "203.0.113.195, 198.51.100.1" },
    } as unknown as IncomingMessage;
    assert.strictEqual(resolveClientIp(reqNoProxies, []), "10.0.0.1");

    // 2. With trusted proxy, walks X-Forwarded-For right-to-left
    const reqWithProxy = {
        socket: { remoteAddress: "10.0.0.1" } as net.Socket,
        headers: { "x-forwarded-for": "203.0.113.195, 10.0.0.2" },
    } as unknown as IncomingMessage;
    assert.strictEqual(resolveClientIp(reqWithProxy, ["10.0.0.0/8"]), "203.0.113.195");

    // 3. Array form of header and missing header
    const reqArrayHeader = {
        socket: { remoteAddress: "10.0.0.1" } as net.Socket,
        headers: { "x-forwarded-for": ["203.0.113.50", "10.0.0.2"] },
    } as unknown as IncomingMessage;
    assert.strictEqual(resolveClientIp(reqArrayHeader, ["10.0.0.0/8"]), "203.0.113.50");

    const reqNoXff = {
        socket: { remoteAddress: "10.0.0.1" } as net.Socket,
        headers: {},
    } as unknown as IncomingMessage;
    assert.strictEqual(resolveClientIp(reqNoXff, ["10.0.0.0/8"]), "10.0.0.1");

    // 4. All addresses in XFF are trusted proxies
    const reqAllTrusted = {
        socket: { remoteAddress: "10.0.0.1" } as net.Socket,
        headers: { "x-forwarded-for": "10.0.0.3, 10.0.0.2" },
    } as unknown as IncomingMessage;
    assert.strictEqual(resolveClientIp(reqAllTrusted, ["10.0.0.0/8"]), "10.0.0.1");
});

test("token: generateToken and getTokenType", () => {
    const tun = generateToken("tun_");
    assert.ok(tun.startsWith("tun_"));
    assert.strictEqual(getTokenType(tun), "tunnel");

    const edg = generateToken("edg_");
    assert.ok(edg.startsWith("edg_"));
    assert.strictEqual(getTokenType(edg), "edge");

    const tmp = generateToken("tmp_");
    assert.ok(tmp.startsWith("tmp_"));
    assert.strictEqual(getTokenType(tmp), "ticket");

    assert.strictEqual(getTokenType("unknown_123"), "unknown");
    assert.strictEqual(getTokenType(""), "unknown");
    assert.strictEqual(getTokenType(null), "unknown");
    assert.strictEqual(getTokenType(undefined), "unknown");
});
