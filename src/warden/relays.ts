import type { WebSocket } from "ws";
import { isReason, MAX_STREAMS_PER_RELAY, type Reason } from "../constants.ts";
import { MuxSession } from "../mux/session.ts";
import { closeWithReason, getLocalCloseReason, registerHeartbeat } from "../ws/heartbeat.ts";

/**
 * The relay sessions Edges hold to this Hub worker: WebSockets the Edge dials on request
 * (`open_relay` on its lifeline), each carrying streams the Hub opens, one per runtime stream.
 * Edges sit on home networks, where streams sharing one WebSocket wait a round trip on each
 * other, and streams stay on their session for life (keep-alive connections), so a new stream
 * goes on an idle session; when every session carries a stream, the Edge is asked for one more
 * and the stream waits up to SPARE_WAIT_MS for it (requests run in parallel, up to
 * MAX_RELAY_SESSIONS), else it shares the least loaded one. Taking the last idle session asks
 * for a spare ahead of the next stream. A session is skipped while clogged: CLOG_STREAMS
 * streams, more than CLOG_QUEUED_BYTES waiting to go out for over CLOG_QUEUED_MS, or a round trip
 * over CLOG_RTT_FACTOR x its best + CLOG_RTT_SLACK_MS. Idle sessions close after RELAY_IDLE_MS,
 * except the one an Edge keeps with its lifeline worker.
 *
 * Every session is pinged each second, idle ones included: a path can drop a WebSocket without a
 * close (Cloudflare cuts an Edge's connections as a group, latency bench S20), and the 30 s
 * heartbeat would leave new streams on the dead session until then. A session whose ping is
 * unanswered for RELAY_SUSPECT_MS, with nothing received since, is no longer picked or counted as
 * live (a spare is asked for instead); after RELAY_STALE_MS with nothing queued ahead of the ping,
 * or RELAY_STALE_BUSY_MS in any case, it is terminated.
 */
export const MAX_RELAY_SESSIONS = 64;
export const SPARE_WAIT_MS = 1000;
const CLOG_STREAMS = 32;
const CLOG_QUEUED_BYTES = 512 * 1024;
const CLOG_QUEUED_MS = 50;
const CLOG_RTT_FACTOR = 2;
const CLOG_RTT_SLACK_MS = 20;
export const RELAY_IDLE_MS = 30_000;
const RELAY_REQUEST_TIMEOUT_MS = 10_000;
export const RELAY_SUSPECT_MS = 1000;
export const RELAY_STALE_MS = 3000;
export const RELAY_STALE_BUSY_MS = 10_000;

export interface Relay {
    edgeId: string;
    ws: WebSocket;
    session: MuxSession;
    idleSince: number;
    queuedSince: number;
    rttMin: number;
    rttSmooth: number;
    /** Streams placed on it and not opened yet. */
    reserved: number;
    /** When its oldest unanswered ping went out (0: none, or something was received since). */
    probeSince: number;
}

interface Waiter {
    resolve: () => void;
    reject: (reason: Reason) => void;
}

const relays = new Map<string, Relay[]>();
const waiters = new Map<string, Set<Waiter>>();
const spareWaiters = new Map<string, ((relay: Relay | null) => void)[]>();
const requestedAt = new Map<string, number[]>();

let requester: (edgeId: string) => void = () => {};
let keepsWarm: (edgeId: string) => boolean = () => false;
let timers: NodeJS.Timeout[] = [];

/** How to ask an Edge for a session, and whether this worker keeps one warm for it. */
export function configureRelays(options: {
    request: (edgeId: string) => void;
    keepWarm: (edgeId: string) => boolean;
}): void {
    requester = options.request;
    keepsWarm = options.keepWarm;
    if (timers.length) return;
    timers = [setInterval(probeRelays, 1000), setInterval(reapIdle, 5000)];
    timers.forEach((t) => t.unref());
}

export function stopRelays(): void {
    timers.forEach(clearInterval);
    timers = [];
}

function pendingRequests(edgeId: string): number[] {
    const asked = (requestedAt.get(edgeId) ?? []).filter(
        (at) => Date.now() - at < RELAY_REQUEST_TIMEOUT_MS
    );
    requestedAt.set(edgeId, asked);
    return asked;
}

/** Asks the Edge for one more session; false once MAX_RELAY_SESSIONS are up or asked for. */
export function requestRelay(edgeId: string, force = false): boolean {
    const asked = pendingRequests(edgeId);
    if (!force && liveRelays(edgeId).length + asked.length >= MAX_RELAY_SESSIONS) return false;
    asked.push(Date.now());
    requester(edgeId);
    return true;
}

/** The Edge's sessions that are open and answering (see RELAY_SUSPECT_MS). */
export function liveRelays(edgeId: string): Relay[] {
    return (relays.get(edgeId) ?? []).filter((r) => r.session.open && !suspect(r));
}

const suspect = (r: Relay) => r.probeSince > 0 && Date.now() - r.probeSince >= RELAY_SUSPECT_MS;

/**
 * The Edge dialed a new lifeline, so the path its sessions shared may have dropped them: they are
 * not picked until they answer a ping, and a fresh session is asked for at once.
 */
export function suspectRelays(edgeId: string): void {
    for (const r of relays.get(edgeId) ?? []) {
        if (!r.session.open) continue;
        ping(r);
        r.probeSince = Math.min(r.probeSince || Infinity, Date.now() - RELAY_SUSPECT_MS);
    }
    requestRelay(edgeId, true);
}

function clogged(r: Relay): boolean {
    if (r.session.size >= CLOG_STREAMS) return true;
    if (r.ws.bufferedAmount > CLOG_QUEUED_BYTES) {
        if (!r.queuedSince) r.queuedSince = Date.now();
        if (Date.now() - r.queuedSince > CLOG_QUEUED_MS) return true;
    } else {
        r.queuedSince = 0;
    }
    return r.rttMin > 0 && r.rttSmooth > CLOG_RTT_FACTOR * r.rttMin + CLOG_RTT_SLACK_MS;
}

const load = (r: Relay) => r.session.size + r.reserved;
const lighter = (a: Relay, b: Relay) =>
    load(b) < load(a) || (load(b) === load(a) && b.ws.bufferedAmount < a.ws.bufferedAmount) ? b : a;

/** The least loaded session that is not clogged (else the least loaded), if any is up. */
export function pickRelay(edgeId: string): Relay | undefined {
    const live = liveRelays(edgeId);
    if (!live.length) return undefined;
    const free = live.filter((r) => !clogged(r) && load(r) < MAX_STREAMS_PER_RELAY);
    return (free.length ? free : live).reduce(lighter);
}

/**
 * The session for a new stream (see above), reserved for it: the caller opens the stream on it
 * and gives the reservation back. Rejects with a reason when no session comes before the deadline.
 */
export async function placeStream(
    edgeId: string,
    deadline: number,
    signal?: AbortSignal
): Promise<Relay> {
    let relay = pickRelay(edgeId);
    if (!relay) {
        requestRelay(edgeId);
        await waitForRelay(edgeId, deadline, signal);
        relay = pickRelay(edgeId);
        if (!relay) throw "relay_dial_failed";
    }
    if (load(relay) > 0 && requestRelay(edgeId)) {
        const spare = await waitForSpare(edgeId, Math.min(deadline, Date.now() + SPARE_WAIT_MS));
        if (signal?.aborted) {
            if (spare) spare.reserved--;
            throw (signal.reason as Reason) ?? "client_aborted";
        }
        if (spare) return spare;
        relay = pickRelay(edgeId) ?? relay;
    } else if (!liveRelays(edgeId).some((r) => r !== relay && load(r) === 0)) {
        requestRelay(edgeId);
    }
    relay.reserved++;
    return relay;
}

// The next session to come up, already reserved; null when none comes before `until`.
function waitForSpare(edgeId: string, until: number): Promise<Relay | null> {
    return new Promise((resolve) => {
        const list = spareWaiters.get(edgeId) ?? [];
        spareWaiters.set(edgeId, list);
        const give = (relay: Relay | null) => {
            clearTimeout(timer);
            resolve(relay);
        };
        const timer = setTimeout(
            () => {
                list.splice(list.indexOf(give) >>> 0, 1);
                resolve(null);
            },
            Math.max(1, until - Date.now())
        );
        list.push(give);
    });
}

function releaseSpareWaiters(edgeId: string): void {
    for (const give of spareWaiters.get(edgeId)?.splice(0) ?? []) give(null);
}

/** Resolves once a session of the Edge is up here; rejects at the deadline or on abort. */
export function waitForRelay(edgeId: string, deadline: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const set = waiters.get(edgeId) ?? new Set<Waiter>();
        waiters.set(edgeId, set);
        const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            set.delete(waiter);
        };
        const waiter: Waiter = {
            resolve: () => (done(), resolve()),
            reject: (reason) => (done(), reject(reason)),
        };
        const onAbort = () => waiter.reject((signal?.reason as Reason) ?? "client_aborted");
        const timer = setTimeout(
            () => waiter.reject("connect_timeout"),
            Math.max(1, deadline - Date.now())
        );
        set.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

function settleWaiters(edgeId: string, reason?: Reason): void {
    for (const w of [...(waiters.get(edgeId) ?? [])]) {
        if (reason) w.reject(reason);
        else w.resolve();
    }
}

/** No session is coming (the Edge could not dial it, or its lifeline dropped): waiters fail. */
export function relayRequestFailed(edgeId: string, reason: Reason = "relay_dial_failed"): void {
    requestedAt.delete(edgeId);
    settleWaiters(edgeId, reason);
    releaseSpareWaiters(edgeId);
}

/** A relay session of the Edge is up on this worker. */
export function registerRelay(edgeId: string, ws: WebSocket): Relay {
    const relay: Relay = {
        edgeId,
        ws,
        // an Edge dropping without a reason is the target side ending (or the local heartbeat)
        session: new MuxSession(ws, {
            endReason: (peer) =>
                getLocalCloseReason(ws) ?? (isReason(peer) ? peer : "target_close"),
        }),
        idleSince: Date.now(),
        queuedSince: 0,
        rttMin: 0,
        rttSmooth: 0,
        reserved: 0,
        probeSince: 0,
    };
    registerHeartbeat(ws);
    relays.set(edgeId, [...(relays.get(edgeId) ?? []), relay]);
    pendingRequests(edgeId).shift();
    ws.on("pong", (data: Buffer) => onPong(relay, data));
    // anything the Edge sends proves the session alive, also when its pong waits behind that data
    ws.on("message", () => (relay.probeSince = 0));
    ws.once("close", () => {
        const left = (relays.get(edgeId) ?? []).filter((r) => r !== relay);
        if (left.length) relays.set(edgeId, left);
        else relays.delete(edgeId);
        // the Edge still has streams to serve here, or this worker keeps one warm for it
        if (!left.length && (waiters.get(edgeId)?.size || keepsWarm(edgeId))) {
            requestRelay(edgeId);
        }
    });
    // a stream waiting for a spare takes it; streams waiting for any session wake up
    const give = spareWaiters.get(edgeId)?.shift();
    if (give) {
        relay.reserved++;
        give(relay);
    }
    settleWaiters(edgeId);
    return relay;
}

/** Closes the Edge's relay sessions on this worker (all Edges without an id). */
export function closeRelays(edgeId: string | null, reason: Reason): number {
    let closed = 0;
    for (const [id, list] of relays) {
        if (edgeId && id !== edgeId) continue;
        for (const r of list) {
            r.session.end(reason);
            closeWithReason(r.ws, reason);
            closed++;
        }
    }
    for (const id of edgeId
        ? [edgeId]
        : [...new Set([...waiters.keys(), ...spareWaiters.keys()])]) {
        settleWaiters(id, reason);
        releaseSpareWaiters(id);
    }
    return closed;
}

const PING_TAG = 0x52;

function ping(r: Relay): void {
    const payload = Buffer.alloc(9);
    payload[0] = PING_TAG;
    payload.writeDoubleBE(performance.now(), 1);
    try {
        r.ws.ping(payload);
    } catch {}
}

/** Each second: sessions silent past RELAY_STALE_MS are terminated, the others pinged. */
export function probeRelays(): void {
    const now = Date.now();
    for (const list of relays.values()) {
        for (const r of list) {
            if (!r.session.open) continue;
            const silent = r.probeSince ? now - r.probeSince : 0;
            // data queued ahead of the ping delays its pong: only a long silence counts then
            if (
                silent >= RELAY_STALE_BUSY_MS ||
                (silent >= RELAY_STALE_MS && !r.ws.bufferedAmount)
            ) {
                closeWithReason(r.ws, "heartbeat_timeout");
                // the peer is gone: no close handshake to wait for
                r.ws.terminate();
                continue;
            }
            ping(r);
            if (!r.probeSince) r.probeSince = now;
        }
    }
}

function onPong(r: Relay, data: Buffer): void {
    r.probeSince = 0;
    if (data?.length !== 9 || data[0] !== PING_TAG) return;
    const rtt = performance.now() - data.readDoubleBE(1);
    if (!r.rttMin || rtt < r.rttMin) r.rttMin = rtt;
    r.rttSmooth = r.rttSmooth ? (r.rttSmooth * 3 + rtt) / 4 : rtt;
}

// Idle sessions close after RELAY_IDLE_MS; the last one stays while this worker keeps it warm
// for the Edge, else after 4 x RELAY_IDLE_MS.
function reapIdle(): void {
    const now = Date.now();
    for (const [edgeId, list] of relays) {
        let left = list.length;
        for (const r of list) {
            if (load(r) > 0) {
                r.idleSince = 0;
                continue;
            }
            if (!r.idleSince) {
                r.idleSince = now;
                continue;
            }
            const last = left === 1;
            if (last && keepsWarm(edgeId)) continue;
            if (now - r.idleSince > (last ? 4 : 1) * RELAY_IDLE_MS) {
                closeWithReason(r.ws, "client_close");
                left--;
            }
        }
    }
}
