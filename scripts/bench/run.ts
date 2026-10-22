/**
 * Hub load bench: forks an echo target and a single-process hub (scripts/bench/hub.ts), creates
 * a direct tunnel to the target, then drives it with worker-thread WebSocket clients
 * (scripts/bench/client.ts) and reports ops/s, p50/p99/max latency, hub CPU % and peak RSS.
 *
 *   node scripts/bench/run.ts --mode rr --clients 1,16,64 --duration 10 --size 64
 *   node scripts/bench/run.ts --mode rr --clients 64 --bulk 4         # plus 4 bulk streams
 *   node scripts/bench/run.ts --mode connect --clients 4 --pace 5     # ~600 new tunnels/s
 *   node scripts/bench/run.ts --redis-url redis://:secret@127.0.0.1:6379 --cpu-prof /tmp/prof
 */
import { fork, type ChildProcess } from "node:child_process";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { values: opts } = parseArgs({
    options: {
        mode: { type: "string", default: "rr" },
        clients: { type: "string", default: "1,16,64" },
        bulk: { type: "string", default: "0" },
        duration: { type: "string", default: "10" },
        warmup: { type: "string", default: "2" },
        size: { type: "string", default: "64" },
        pace: { type: "string", default: "0" },
        threads: { type: "string", default: "4" },
        "redis-url": { type: "string" },
        "cpu-prof": { type: "string" },
        json: { type: "boolean", default: false },
    },
});

const here = path.dirname(new URL(import.meta.url).pathname);

function forkReady(
    script: string,
    args: string[],
    execArgv: string[] = []
): Promise<[ChildProcess, any]> {
    const child = fork(path.join(here, script), args, { execArgv, stdio: "inherit" });
    return new Promise((resolve, reject) => {
        child.once("message", (msg) => resolve([child, msg]));
        child.once("exit", (code) => reject(new Error(`${script} exited with ${code}`)));
    });
}

let statsSeq = 0;
function hubStats(hub: ChildProcess, resetLoop = false): Promise<any> {
    const id = ++statsSeq;
    return new Promise((resolve) => {
        const onMsg = (msg: any) => {
            if (msg?.type !== "stats" || msg.id !== id) return;
            hub.off("message", onMsg);
            resolve(msg);
        };
        hub.on("message", onMsg);
        hub.send({ type: "stats", id, resetLoop });
    });
}

function runWorkers(job: object, clients: number, threads: number): Promise<any[]> {
    const n = Math.min(threads, clients);
    return Promise.all(
        Array.from({ length: n }, (_, i) => {
            const share = Math.floor(clients / n) + (i < clients % n ? 1 : 0);
            const w = new Worker(path.join(here, "client.ts"), {
                workerData: { ...job, clients: share },
            });
            return new Promise<any>((resolve, reject) => {
                w.once("message", resolve);
                w.once("error", reject);
            });
        })
    );
}

function pct(sorted: Float64Array, p: number): number {
    if (sorted.length === 0) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnels-bench-"));
const hubArgs = ["--port", "0", "--data-dir", dataDir, "--workers", "1", "--log-level", "warn"];
if (opts["redis-url"]) hubArgs.push("--redis-url", opts["redis-url"]);
const hubExecArgv = ["--max-old-space-size=160"];
if (opts["cpu-prof"]) hubExecArgv.push("--cpu-prof", `--cpu-prof-dir=${opts["cpu-prof"]}`);

const [target, targetReady] = await forkReady("target.ts", []);
const [hub, hubReady] = await forkReady("hub.ts", hubArgs, hubExecArgv);
const base = `http://127.0.0.1:${hubReady.port}`;

const res = await fetch(`${base}/tunnels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        name: "bench",
        internalHost: "127.0.0.1",
        internalPort: targetReady.port,
    }),
});
const { token } = (await res.json()) as any;
if (!token) throw new Error(`tunnel creation failed: ${res.status}`);

const durationMs = Number(opts.duration) * 1000;
const warmupMs = Number(opts.warmup) * 1000;
const job = {
    url: `ws://127.0.0.1:${hubReady.port}/`,
    token,
    mode: opts.mode,
    size: Number(opts.size),
    warmupMs,
    durationMs,
    paceMs: Number(opts.pace),
};
const bulk = Number(opts.bulk);
const results: any[] = [];

for (const clients of opts.clients.split(",").map(Number)) {
    let peakRss = 0;
    let peakHeap = 0;
    let peakExt = 0;
    let before: any = null;
    const sampler = setInterval(async () => {
        const s = await hubStats(hub);
        peakRss = Math.max(peakRss, s.mem.rss);
        peakHeap = Math.max(peakHeap, s.mem.heapUsed);
        peakExt = Math.max(peakExt, s.mem.arrayBuffers);
    }, 250);
    // CPU is measured over the measured window only (after warmup).
    const cpuStart = new Promise<void>((r) =>
        setTimeout(async () => {
            before = await hubStats(hub, true);
            r();
        }, warmupMs)
    );
    let after: any = null;
    const cpuEnd = new Promise<void>((r) =>
        setTimeout(async () => {
            after = await hubStats(hub);
            r();
        }, warmupMs + durationMs)
    );
    const threads = Number(opts.threads);
    const [main, bulkOut] = await Promise.all([
        runWorkers(job, clients, threads),
        bulk > 0 ? runWorkers({ ...job, mode: "bulk" }, bulk, 1) : Promise.resolve([]),
    ]);
    await Promise.all([cpuStart, cpuEnd]);
    clearInterval(sampler);

    const all = main.flatMap((r) => r.latencies);
    const sorted = Float64Array.from(all).sort();
    const ops = main.reduce((a, r) => a + r.ops, 0);
    const cpuUs = after.cpu.user + after.cpu.system - (before.cpu.user + before.cpu.system);
    const row = {
        mode: opts.mode,
        clients,
        bulk,
        opsPerSec: Math.round(ops / (durationMs / 1000)),
        p50: +pct(sorted, 50).toFixed(2),
        p99: +pct(sorted, 99).toFixed(2),
        max: +(sorted[sorted.length - 1] ?? NaN).toFixed(2),
        bulkMBps: +(
            bulkOut.reduce((a: number, r: any) => a + r.bytes, 0) /
            (durationMs / 1000) /
            1e6
        ).toFixed(1),
        hubCpuPct: Math.round((cpuUs / 1000 / durationMs) * 100),
        hubCpuUsPerOp: ops ? +(cpuUs / ops).toFixed(1) : NaN,
        hubLoopDelayP99: +after.loop.p99.toFixed(1),
        hubLoopDelayMax: +after.loop.max.toFixed(1),
        hubPeakRssMB: Math.round(peakRss / 1e6),
        hubPeakHeapMB: Math.round(peakHeap / 1e6),
        hubPeakBuffersMB: Math.round(peakExt / 1e6),
        errors: main.reduce((a, r) => a + r.errors, 0),
        errorSamples: [...new Set(main.flatMap((r) => r.errorSamples))].slice(0, 3).join(" | "),
    };
    results.push(row);
    if (!opts.json) console.log(JSON.stringify(row));
}

if (opts.json) console.log(JSON.stringify(results));
else console.table(results);

hub.send({ type: "stop" });
await new Promise((r) => hub.once("exit", r));
target.kill();
fs.rmSync(dataDir, { recursive: true, force: true });
