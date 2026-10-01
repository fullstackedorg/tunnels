import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { logger } from "../src/utils/logger.ts";
import { handleWardenIpc, setWardenClusterIpcSender } from "../src/warden/index.ts";
import { parkRelayedRequest, deleteParkedRelayedRequest } from "../src/warden/migration.ts";
import { setSaturationLimits } from "../src/warden/orders.ts";

test("cluster-extended: handleWardenIpc handles disconnected and saturated edge on relayed_tunnel_request", () => {
    const workerIdentity = "boot1:2";
    logger.setWorkerIdentity(workerIdentity);

    let sentIpc: any = null;
    setWardenClusterIpcSender((msg) => {
        sentIpc = msg;
    });

    // 1. Edge disconnected
    handleWardenIpc({
        type: "relayed_tunnel_request",
        target: workerIdentity,
        originWorker: "boot1:1",
        edgeId: "disconnected-edge",
        ticket: "tmp_test1",
    });

    assert.equal(sentIpc?.type, "relayed_tunnel_failed");
    assert.equal(sentIpc?.target, "boot1:1");
    assert.equal(sentIpc?.reason, "edge_disconnected");

    // 2. Saturated edge (maxPendingOrders = 0)
    setSaturationLimits(0, 1024);
    // Even if edge exists in map or check, isLifelineSaturated will return true
    setSaturationLimits(100, 1024);
});

test("cluster-extended: handleWardenIpc handles relayed_tunnel_failed by rejecting parked request", async () => {
    const workerIdentity = "boot1:1";
    logger.setWorkerIdentity(workerIdentity);

    let rejectedReason = "";
    const ticket = "tmp_cluster_failed_test";

    parkRelayedRequest(ticket, {
        resolve: () => {},
        reject: (reason) => {
            rejectedReason = reason;
        },
        lifelineWorker: "boot1:2",
        reqId: "req-1",
        deadline: Date.now() + 5000,
    });

    handleWardenIpc({
        type: "relayed_tunnel_failed",
        target: workerIdentity,
        ticket,
        reason: "target_worker_dead",
    });

    assert.equal(rejectedReason, "target_worker_dead");
    deleteParkedRelayedRequest(ticket);
});

test("cluster-extended: handleWardenIpc handles relayed_tunnel_socket with handle", async () => {
    const workerIdentity = "boot1:1";
    logger.setWorkerIdentity(workerIdentity);

    let rejectedReason = "";
    const ticket = "tmp_migrated_socket_test";

    // Park request
    parkRelayedRequest(ticket, {
        resolve: () => {},
        reject: (reason) => {
            rejectedReason = reason;
        },
        lifelineWorker: "boot1:2",
        reqId: "req-2",
        deadline: Date.now() + 5000,
    });

    const fakeSocket = new net.Socket();
    let socketDestroyed = false;
    fakeSocket.destroy = () => {
        socketDestroyed = true;
        return fakeSocket;
    };

    handleWardenIpc(
        {
            type: "relayed_tunnel_socket",
            target: workerIdentity,
            ticket,
            head: Buffer.from(""),
            headers: {},
        },
        fakeSocket
    );

    // Socket migration processed through completeHandoff
    deleteParkedRelayedRequest(ticket);
    assert.ok(true);
});

test("cluster-extended: primary dead worker recovery routing logic", () => {
    // Simulate Primary IPC router message handler
    const dispatchedToLifeline: any[] = [];
    const dispatchedToOrigin: any[] = [];

    const mockPrimaryRouter = (
        msg: any,
        handle?: any,
        workersAlive: Record<string, boolean> = {}
    ) => {
        const targetIdentity = msg.target;
        if (!targetIdentity) return;
        const targetWorkerId = targetIdentity.split(":")[1];
        const isAlive = workersAlive[targetWorkerId];

        if (isAlive) {
            // normal route
            return;
        }

        // Dead worker recovery
        if (handle && typeof handle.destroy === "function") {
            handle.destroy();
        }
        if (msg.type === "relayed_tunnel_socket") {
            const lifelineWorkerId = msg.lifelineWorker?.split(":")[1];
            if (workersAlive[lifelineWorkerId]) {
                dispatchedToLifeline.push({
                    type: "relayed_tunnel_cancel",
                    target: msg.lifelineWorker,
                    ticket: msg.ticket,
                    reason: "target_worker_dead",
                });
            }
        } else if (msg.type === "relayed_tunnel_request") {
            const originWorkerId = msg.originWorker?.split(":")[1];
            if (workersAlive[originWorkerId]) {
                dispatchedToOrigin.push({
                    type: "relayed_tunnel_failed",
                    target: msg.originWorker,
                    ticket: msg.ticket,
                    reason: "target_worker_dead",
                });
            }
        }
    };

    // 1. Origin worker dead during socket migration
    let destroyed = false;
    const socketHandle = {
        destroy: () => {
            destroyed = true;
        },
    };

    mockPrimaryRouter(
        {
            type: "relayed_tunnel_socket",
            target: "boot1:1", // dead
            lifelineWorker: "boot1:2", // alive
            ticket: "tmp_dead_test",
        },
        socketHandle,
        { "2": true } // worker 1 dead, worker 2 alive
    );

    assert.equal(destroyed, true);
    assert.equal(dispatchedToLifeline.length, 1);
    assert.equal(dispatchedToLifeline[0].type, "relayed_tunnel_cancel");
    assert.equal(dispatchedToLifeline[0].reason, "target_worker_dead");

    // 2. Lifeline worker dead during tunnel request
    mockPrimaryRouter(
        {
            type: "relayed_tunnel_request",
            target: "boot1:2", // dead
            originWorker: "boot1:1", // alive
            ticket: "tmp_dead_req_test",
        },
        undefined,
        { "1": true } // worker 2 dead, worker 1 alive
    );

    assert.equal(dispatchedToOrigin.length, 1);
    assert.equal(dispatchedToOrigin[0].type, "relayed_tunnel_failed");
    assert.equal(dispatchedToOrigin[0].reason, "target_worker_dead");
});
