import test from "node:test";
import assert from "node:assert/strict";
import { logger } from "../src/utils/logger.ts";
import { handleWardenIpc, setWardenClusterIpcSender } from "../src/warden/index.ts";
import { configureRelays, waitForRelay } from "../src/warden/relays.ts";

test("cluster-extended: a relay request for an Edge with no lifeline here fails back to its worker", () => {
    const workerIdentity = "boot1:2";
    logger.setWorkerIdentity(workerIdentity);

    const sent: any[] = [];
    setWardenClusterIpcSender((msg) => sent.push(msg));
    try {
        handleWardenIpc({
            type: "relay_request",
            target: workerIdentity,
            edgeId: "disconnected-edge",
            worker: "boot1:1",
        });
        assert.deepEqual(sent, [
            {
                type: "relay_failed",
                target: "boot1:1",
                edgeId: "disconnected-edge",
                reason: "edge_disconnected",
            },
        ]);

        // messages for other workers are ignored
        handleWardenIpc({
            type: "relay_request",
            target: "boot1:3",
            edgeId: "x",
            worker: "boot1:1",
        });
        assert.equal(sent.length, 1);
    } finally {
        setWardenClusterIpcSender(null);
    }
});

test("cluster-extended: relay_failed from the lifeline worker fails the streams waiting here", async () => {
    const workerIdentity = "boot1:1";
    logger.setWorkerIdentity(workerIdentity);
    configureRelays({ request: () => {}, keepWarm: () => false });

    const waiting = waitForRelay("edge-remote", Date.now() + 5000);
    handleWardenIpc({
        type: "relay_failed",
        target: workerIdentity,
        edgeId: "edge-remote",
        reason: "target_worker_dead",
    });
    await assert.rejects(waiting, (r) => r === "target_worker_dead");

    const fallback = waitForRelay("edge-remote", Date.now() + 5000);
    handleWardenIpc({ type: "relay_failed", target: workerIdentity, edgeId: "edge-remote" });
    await assert.rejects(fallback, (r) => r === "relay_dial_failed");
});
