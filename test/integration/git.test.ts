import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PORTS, CREDENTIALS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { createTunnelBridge } from "./helpers/bridge.ts";
import { waitForGit } from "./helpers/compose.ts";
import { createTempDir, cleanupTempDir } from "../helpers.ts";

const execFileAsync = promisify(execFile);

test("git: git clone, commit, push, and packfile negotiation over direct tunnel", async () => {
    await waitForGit();
    const harness = await setupIntegrationHarness(false);
    let bridge: Awaited<ReturnType<typeof createTunnelBridge>> | null = null;
    const workDir1 = createTempDir("git-direct-1-");
    const workDir2 = createTempDir("git-direct-2-");

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.git,
            "127.0.0.1",
            "Git Direct"
        );
        bridge = await createTunnelBridge(harness.hubUrl, token);

        const gitUrl = `http://${CREDENTIALS.git.username}:${CREDENTIALS.git.password}@127.0.0.1:${bridge.port}/test.git`;

        // 1. Git clone via direct tunnel
        await execFileAsync("git", ["clone", gitUrl, workDir1]);
        assert.ok(fs.existsSync(`${workDir1}/test.txt`));
        assert.equal(fs.readFileSync(`${workDir1}/test.txt`, "utf-8").trim(), "test file");

        // 2. Commit and push via direct tunnel
        const featureFile = `direct-feature-${Date.now()}.txt`;
        fs.writeFileSync(`${workDir1}/${featureFile}`, `direct feature payload ${Date.now()}\n`);
        await execFileAsync("git", ["-C", workDir1, "config", "user.email", "tester@test.com"]);
        await execFileAsync("git", ["-C", workDir1, "config", "user.name", "Tester"]);
        await execFileAsync("git", ["-C", workDir1, "add", featureFile]);
        await execFileAsync("git", ["-C", workDir1, "commit", "-m", "feature commit"]);
        await execFileAsync("git", ["-C", workDir1, "push", "origin", "main"]);

        // 3. Clone / pull to second directory and verify packfile negotiation
        await execFileAsync("git", ["clone", gitUrl, workDir2]);
        assert.ok(fs.existsSync(`${workDir2}/${featureFile}`));
    } finally {
        cleanupTempDir(workDir1);
        cleanupTempDir(workDir2);
        if (bridge) await bridge.close();
        await harness.close();
    }
});

test("git: git pull and smart HTTP negotiation over edge relayed tunnel", async () => {
    await waitForGit();
    const harness = await setupIntegrationHarness(true);
    let bridge: Awaited<ReturnType<typeof createTunnelBridge>> | null = null;
    const workDir = createTempDir("git-relayed-");

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.git,
            "127.0.0.1",
            "Git Relayed"
        );
        bridge = await createTunnelBridge(harness.hubUrl, token);

        const gitUrl = `http://${CREDENTIALS.git.username}:${CREDENTIALS.git.password}@127.0.0.1:${bridge.port}/test.git`;

        // Clone over relayed tunnel
        await execFileAsync("git", ["clone", gitUrl, workDir]);
        assert.ok(fs.existsSync(`${workDir}/test.txt`));

        // Create commit and push over relayed tunnel
        const relayedFile = `relayed-feature-${Date.now()}.txt`;
        fs.writeFileSync(`${workDir}/${relayedFile}`, `relayed feature data ${Date.now()}\n`);
        await execFileAsync("git", ["-C", workDir, "config", "user.email", "relayed@test.com"]);
        await execFileAsync("git", ["-C", workDir, "config", "user.name", "RelayedTester"]);
        await execFileAsync("git", ["-C", workDir, "add", relayedFile]);
        await execFileAsync("git", ["-C", workDir, "commit", "-m", "relayed commit"]);
        await execFileAsync("git", ["-C", workDir, "push", "origin", "main"]);

        // Fetch / pull verification
        const { stdout: log } = await execFileAsync("git", [
            "-C",
            workDir,
            "log",
            "-n",
            "1",
            "--oneline",
        ]);
        assert.ok(log.includes("relayed commit"));
    } finally {
        cleanupTempDir(workDir);
        if (bridge) await bridge.close();
        await harness.close();
    }
});
