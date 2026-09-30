import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startHub, type HubInstance } from "../src/hub/index.ts";
import { parseConfig } from "../src/utils/config.ts";
import { EdgeLifeline } from "../src/edge/lifeline.ts";
import { getAvailablePort, createTempDir, cleanupTempDir, jsonFetch } from "./helpers.ts";

test("edge_revocation: edge enters revoked state on 401 and recovers when TOKEN_FILE is updated", async () => {
    const hubPort = await getAvailablePort();
    const dir = createTempDir("edge-revoc-");
    const tokenFilePath = path.join(dir, "edge-token.txt");

    // Write an invalid token initially
    fs.writeFileSync(tokenFilePath, "edg_invalid_token_123");

    const hubConfig = parseConfig(["--port", String(hubPort), "--data-dir", dir]);

    let hub: HubInstance | null = null;
    let lifeline: EdgeLifeline | null = null;

    try {
        hub = await startHub(hubConfig);
        const baseUrl = `http://127.0.0.1:${hubPort}`;

        // Create genuine Edge entity on Hub
        const edgeRes = await jsonFetch(`${baseUrl}/edges`, {
            method: "POST",
            body: { name: "Dynamic Token Edge" },
        });
        assert.equal(edgeRes.status, 201);
        const edgeId = edgeRes.data.id;
        const validToken = edgeRes.data.token;

        const edgeConfig = parseConfig([
            "--hub-url",
            `ws://127.0.0.1:${hubPort}`,
            "--token-file",
            tokenFilePath,
            "--revoked-poll-interval",
            "1", // Poll quickly in test (1s)
            "--reconnect-interval",
            "1",
        ]);

        lifeline = new EdgeLifeline({ config: edgeConfig });
        lifeline.start();

        // Edge initially connects with invalid token -> Hub returns 401 -> Edge enters revoked state
        await new Promise((r) => setTimeout(r, 200));

        const initialCheck = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
        assert.equal(initialCheck.data.connected, false);

        // Update token file on disk with the valid token!
        fs.writeFileSync(tokenFilePath, validToken);

        // Wait for revoked poll loop to pick up new token and connect
        let recovered = false;
        for (let i = 0; i < 30; i++) {
            const check = await jsonFetch(`${baseUrl}/edges/${edgeId}`);
            if (check.data.connected) {
                recovered = true;
                break;
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        assert.equal(
            recovered,
            true,
            "Edge failed to recover from revoked state after token file update"
        );
    } finally {
        if (lifeline) await lifeline.stop();
        if (hub) await hub.close();
        cleanupTempDir(dir);
    }
});
