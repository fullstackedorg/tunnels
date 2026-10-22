/**
 * Load bench client (a worker thread of scripts/bench/run.ts). Drives `clients` tunnel
 * WebSockets against an echo target in one of three modes:
 *   rr      — one connection each, send `size` bytes, wait for the echo, repeat (latency per op);
 *   bulk    — one connection each, stream 64 KiB chunks with backpressure (echoed bytes);
 *   connect — open a tunnel, one `size`-byte round trip, close, repeat (setup latency per op).
 */
import { parentPort, workerData } from "node:worker_threads";
import WebSocket from "ws";

interface Job {
    url: string;
    token: string;
    clients: number;
    mode: "rr" | "bulk" | "connect";
    size: number;
    /** rr mode: frames each request is split into, sent back to back (like a driver's writes). */
    frames: number;
    warmupMs: number;
    durationMs: number;
    /** connect mode: pause between connections, in ms (loopback ephemeral ports run out fast). */
    paceMs: number;
}

const job = workerData as Job;
const latencies: number[] = [];
let ops = 0;
let bytes = 0;
let errors = 0;
const errorSamples = new Set<string>();
const start = performance.now();
const measureFrom = start + job.warmupMs;
const stopAt = measureFrom + job.durationMs;

function record(t0: number, n = 1): void {
    if (t0 < measureFrom) return;
    latencies.push(performance.now() - t0);
    ops += n;
}

function open(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(job.url, { headers: { Authorization: job.token } });
        ws.binaryType = "nodebuffer";
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
    });
}

/** Sends `payload` and resolves once as many bytes came back. */
function roundTrip(ws: WebSocket, payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        let got = 0;
        const onMessage = (data: Buffer) => {
            got += data.length;
            if (got >= payload.length) {
                ws.off("message", onMessage);
                ws.off("close", onClose);
                resolve();
            }
        };
        const onClose = () => reject(new Error("closed"));
        ws.on("message", onMessage);
        ws.once("close", onClose);
        const step = Math.ceil(payload.length / job.frames);
        for (let i = 0; i < payload.length; i += step) ws.send(payload.subarray(i, i + step));
    });
}

async function rrClient(): Promise<void> {
    const ws = await open();
    const payload = Buffer.alloc(job.size, 0x61);
    while (performance.now() < stopAt) {
        const t0 = performance.now();
        await roundTrip(ws, payload);
        record(t0);
    }
    ws.close();
}

async function connectClient(): Promise<void> {
    const payload = Buffer.alloc(job.size, 0x62);
    while (performance.now() < stopAt) {
        const t0 = performance.now();
        let ws: WebSocket | null = null;
        try {
            ws = await open();
            await roundTrip(ws, payload);
            record(t0);
        } catch (err: any) {
            // Keep going (e.g. EADDRNOTAVAIL once loopback ephemeral ports sit in TIME_WAIT).
            errors++;
            errorSamples.add(String(err?.message ?? err));
            await new Promise((r) => setTimeout(r, 10));
        }
        if (ws && ws.readyState !== ws.CLOSED) {
            await new Promise<void>((resolve) => {
                ws!.once("close", () => resolve());
                ws!.close();
            });
        }
        if (job.paceMs > 0) await new Promise((r) => setTimeout(r, job.paceMs));
    }
}

async function bulkClient(): Promise<void> {
    const ws = await open();
    const chunk = Buffer.alloc(64 * 1024, 0x63);
    ws.on("message", (data: Buffer) => {
        if (performance.now() >= measureFrom) bytes += data.length;
    });
    while (performance.now() < stopAt) {
        if (ws.bufferedAmount > 1024 * 1024) {
            await new Promise((r) => setTimeout(r, 1));
            continue;
        }
        await new Promise<void>((resolve) => ws.send(chunk, () => resolve()));
    }
    ws.close();
}

const run = { rr: rrClient, bulk: bulkClient, connect: connectClient }[job.mode];
await Promise.all(
    Array.from({ length: job.clients }, () =>
        run().catch((err) => {
            errors++;
            errorSamples.add(String(err?.message ?? err));
        })
    )
);
parentPort!.postMessage({ latencies, ops, bytes, errors, errorSamples: [...errorSamples] });
