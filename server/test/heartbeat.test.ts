import test from "node:test";
import assert from "node:assert";
import * as ws from "ws";
import crypto from "node:crypto";
import { setupTestServer } from "./helpers.ts";
import * as connect from "../src/connect.ts";
import * as warden from "../src/warden/index.ts";
import * as kv from "../src/kv/index.ts";
import type { Machine } from "../src/entities/schema/machine.ts";

const PORT = 3470;
process.env.HEARTBEAT_INTERVAL = "200"; // fast heartbeats for testing
await setupTestServer(PORT);

test("Lifeline heartbeat updates heartbeat status on both Warden and Connecting Machine", async () => {
    // 1. Register a Machine
    const machineRes = await fetch(`http://127.0.0.1:${PORT}/machines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "test-heartbeat-machine",
        }),
    });
    assert.strictEqual(machineRes.status, 200);
    const machine = (await machineRes.json()) as Machine;
    await kv.set(`machines:${machine.token}`, machine);

    // 2. Connect machine using connectToRelay in-process
    process.env.RELAY_URL = `ws://127.0.0.1:${PORT}`;
    process.env.TOKEN = machine.token;
    process.env.HEARTBEAT_INTERVAL = "200";

    const connectPromise = connect.connectToRelay();

    // 3. Wait for connection to establish
    await new Promise((r) => setTimeout(r, 1000));

    // Verify machine is connected
    const connected = await warden.isMachineConnected(machine);
    assert.strictEqual(connected, true, "Machine should be connected");

    // 4. Verify connecting machine has heartbeat status
    const machineStatus1 = connect.getHeartbeatStatus();
    assert.strictEqual(machineStatus1.alive, true);
    assert.ok(
        machineStatus1.lastHeartbeat !== null,
        "Machine lastHeartbeat should be set",
    );

    // 5. Verify warden has heartbeat status
    const wardenStatus1 = await warden.getMachineHeartbeatStatus(machine.id);
    assert.ok(wardenStatus1, "Warden status should exist");
    assert.strictEqual(wardenStatus1?.alive, true);
    assert.ok(
        wardenStatus1?.lastHeartbeat !== null,
        "Warden lastHeartbeat should be set",
    );

    // 6. Verify GET /machines API endpoint returns heartbeat status
    const listRes = await fetch(`http://127.0.0.1:${PORT}/machines`);
    const machines = await listRes.json();
    const currentMachine = machines.find((m: any) => m.id === machine.id);
    assert.ok(currentMachine, "Machine should be found in list");
    assert.strictEqual(currentMachine.connected, true);
    assert.strictEqual(currentMachine.heartbeat.alive, true);
    assert.ok(currentMachine.heartbeat.lastHeartbeat > 0);

    // 7. Wait for multiple heartbeats to occur and verify timestamps update
    const t0Machine = machineStatus1.lastHeartbeat;
    const t0Warden = wardenStatus1!.lastHeartbeat;

    await new Promise((r) => setTimeout(r, 800));

    const machineStatus2 = connect.getHeartbeatStatus();
    const wardenStatus2 = await warden.getMachineHeartbeatStatus(machine.id);

    assert.strictEqual(machineStatus2.alive, true);
    assert.strictEqual(wardenStatus2?.alive, true);
    assert.ok(
        machineStatus2.lastHeartbeat! >= t0Machine!,
        "Machine heartbeat timestamp should have progressed",
    );
    assert.ok(
        wardenStatus2!.lastHeartbeat! >= t0Warden!,
        "Warden heartbeat timestamp should have progressed",
    );

    // 8. Stop connection and verify status reflects disconnection
    connect.stopConnectToRelay();
    await connectPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 700));

    const machineStatusAfterStop = connect.getHeartbeatStatus();
    assert.strictEqual(machineStatusAfterStop.alive, false);

    const wardenStatusAfterStop = await warden.getMachineHeartbeatStatus(
        machine.id,
    );
    assert.strictEqual(
        wardenStatusAfterStop,
        null,
        "Warden heartbeat should be cleaned up",
    );

    const connectedAfterStop = await warden.isMachineConnected(machine);
    assert.strictEqual(connectedAfterStop, false);
});

test("Warden terminates dead lifeline when ping is unacknowledged", async () => {
    let rawWs: ws.WebSocket | null = null;
    try {
        // 1. Create a dummy machine via API
        const machineRes = await fetch(`http://127.0.0.1:${PORT}/machines`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "test-dead-machine",
            }),
        });
        assert.strictEqual(machineRes.status, 200);
        const machine = (await machineRes.json()) as Machine;
        await kv.set(`machines:${machine.token}`, machine);

        // 2. Connect a raw websocket client that ignores pings (does not auto-respond or drops pong)
        rawWs = new ws.WebSocket(`ws://127.0.0.1:${PORT}`, {
            headers: {
                Authorization: machine.token,
                version: "1.0.0",
            },
        });

        await new Promise<void>((resolve, reject) => {
            rawWs!.on("open", resolve);
            rawWs!.on("error", reject);
        });

        // Give a brief tick for server upgrade completion
        await new Promise((r) => setTimeout(r, 100));

        // Verify machine is initially connected
        assert.strictEqual(await warden.isMachineConnected(machine), true);
        const initialStatus = await warden.getMachineHeartbeatStatus(
            machine.id,
        );
        assert.ok(initialStatus?.alive);

        // Block pong from being sent
        (rawWs as any).pong = () => {};

        // Wait for heartbeat interval (HEARTBEAT_INTERVAL is 200ms, so 700ms is enough for missed ping detection)
        await new Promise((r) => setTimeout(r, 700));

        // The warden should have detected missed heartbeat and terminated the ws
        const isConnected = await warden.isMachineConnected(machine);
        assert.strictEqual(
            isConnected,
            false,
            "Warden should have terminated dead lifeline",
        );

        const statusAfterDead = await warden.getMachineHeartbeatStatus(
            machine.id,
        );
        assert.strictEqual(
            statusAfterDead,
            null,
            "Warden heartbeat status should be cleaned up",
        );
    } finally {
        rawWs?.close();
    }
});

test("Connecting machine terminates lifeline when relay ping is unacknowledged", async () => {
    // Create a mock relay WebSocket server that does NOT send pongs back
    const mockWss = new ws.WebSocketServer({ port: 0 });
    const mockPort = (mockWss.address() as any).port;

    mockWss.on("connection", (socket) => {
        // Prevent socket from auto-responding with pong
        (socket as any).pong = () => {};
    });

    process.env.RELAY_URL = `ws://127.0.0.1:${mockPort}`;
    process.env.TOKEN = "test-token";
    process.env.HEARTBEAT_INTERVAL = "200";

    const connectPromise = connect.connectToRelay();

    // Wait for connection to establish
    await new Promise((r) => setTimeout(r, 100));

    // Initially connecting machine status is alive
    const initialStatus = connect.getHeartbeatStatus();
    assert.strictEqual(initialStatus.alive, true);

    // Wait for connecting machine's heartbeat watchdog (200ms interval -> after 700ms missed ping causes terminate)
    await new Promise((r) => setTimeout(r, 600));

    // Stop connect loop so it does not reconnect
    connect.stopConnectToRelay();
    await connectPromise.catch(() => {});

    const statusAfterMissed = connect.getHeartbeatStatus();
    assert.strictEqual(
        statusAfterMissed.alive,
        false,
        "Connecting machine should mark alive=false on missed heartbeat",
    );

    await new Promise<void>((resolve) => mockWss.close(() => resolve()));
});

test.after(() => {
    delete process.env.HEARTBEAT_INTERVAL;
    delete process.env.RELAY_URL;
    delete process.env.TOKEN;
});
