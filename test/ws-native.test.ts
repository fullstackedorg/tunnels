import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Platforms bufferutil ships a prebuilt binary for; elsewhere it falls back to JS.
const PREBUILT = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "win32-ia32"];

test("ws-native: ws unmasks client frames with native bufferutil", (t) => {
    if (!PREBUILT.includes(`${process.platform}-${process.arch}`)) {
        t.skip(`no bufferutil prebuild for ${process.platform}-${process.arch}`);
        return;
    }
    // Resolve the way ws/lib/buffer-util.js does, so a copy ws cannot see does not count.
    const fromWs = createRequire(createRequire(import.meta.url).resolve("ws"));
    const bufferUtil = fromWs("bufferutil");
    assert.match(String(bufferUtil.unmask), /\[native code\]/);

    const data = Buffer.from("0123456789abcdef0123456789abcdef0123456789");
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
    bufferUtil.unmask(masked, mask);
    assert.deepEqual(masked, data);
});
