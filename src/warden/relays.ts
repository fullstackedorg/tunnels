import type { WebSocket } from "ws";
import { isReason, MAX_STREAMS_PER_RELAY, type Reason } from "../constants.ts";
import { MuxSession } from "../mux/session.ts";
import { closeWithReason, getLocalCloseReason, registerHeartbeat } from "../ws/heartbeat.ts";

/**
 * The relay sessions Edges hold to this Hub worker: WebSockets the Edge dials on request
 * (`open_relay` on its lifeline), each carrying many streams the Hub opens, one per runtime
 * stream. Edges sit on home networks, where streams sharing one WebSocket wait on each other, so
 * a new stream goes on the session with the fewest streams, and once every session carries one
 * the Edge is asked for another (a spare), up to MAX_RELAY_SESSIONS. A session is skipped while
 * clogged: CLOG_STREAMS streams, more than CLOG_QUEUED_BYTES waiting to go out for over
 * CLOG_QUEUED_MS, or a round trip over CLOG_RTT_FACTOR x its best + CLOG_RTT_SLACK_MS. Idle
 * sessions close after RELAY_IDLE_MS, except the one an Edge keeps with its lifeline worker.
 */
export const MAX_RELAY_SESSIONS = 8;
const CLOG_STREAMS = 32;
const CLOG_QUEUED_BYTES = 512 * 1024;
const CLOG_QUEUED_MS = 50;
const CLOG_RTT_FACTOR = 2;
const CLOG_RTT_SLACK_MS = 20;
export const RELAY_IDLE_MS = 30_000;
const RELAY_REQUEST_TIMEOUT_MS = 10_000;

export interface Relay {
    edgeId: string;
    ws: WebSocket;
    session: MuxSession;
    idleSince: number;
    queuedSince: number;
    rttMin: number;
    rttSmooth: number;
}

interface Waiter {
    resolve: () => void;
    reject: (reason: Reason) => void;
}

const relays = new Map<string, Relay[]>();
const waiters = new Map<string, Set<Waiter>>();
const requestedAt = new Map<string, number>();

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
    timers = [setInterval(measureRoundTrips, 1000), setInterval(reapIdle, 5000)];
    timers.forEach((t) => t.unref());
}

export function stopRelays(): void {
    timers.forEach(clearInterval);
    timers = [];
}

/** Asks the Edge for one more session, unless a request is already out (or `force`). */
export function requestRelay(edgeId: string, force = false): void {
    const at = requestedAt.get(edgeId);
    if (!force && at && Date.now() - at < RELAY_REQUEST_TIMEOUT_MS) return;
    requestedAt.set(edgeId, Date.now());
    requester(edgeId);
}

export function liveRelays(edgeId: string): Relay[] {
    return (relays.get(edgeId) ?? []).filter((r) => r.session.open);
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

const lighter = (a: Relay, b: Relay) =>
    b.session.size < a.session.size ||
    (b.session.size === a.session.size && b.ws.bufferedAmount < a.ws.bufferedAmount)
        ? b
        : a;

/** The session for a new stream (see above), or undefined when the Edge has none here yet. */
export function pickRelay(edgeId: string): Relay | undefined {
    const live = liveRelays(edgeId);
    if (!live.length) return undefined;
    const free = live.filter((r) => !clogged(r) && r.session.size < MAX_STREAMS_PER_RELAY);
    const chosen = (free.length ? free : live).reduce(lighter);
    const spare = live.some((r) => r !== chosen && r.session.size === 0);
    if (!spare && live.length < MAX_RELAY_SESSIONS) requestRelay(edgeId);
    return chosen;
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
    };
    registerHeartbeat(ws);
    relays.set(edgeId, [...(relays.get(edgeId) ?? []), relay]);
    requestedAt.delete(edgeId);
    ws.on("pong", (data: Buffer) => onPong(relay, data));
    ws.once("close", () => {
        const left = (relays.get(edgeId) ?? []).filter((r) => r !== relay);
        if (left.length) relays.set(edgeId, left);
        else relays.delete(edgeId);
        // the Edge still has streams to serve here, or this worker keeps one warm for it
        if (!left.length && (waiters.get(edgeId)?.size || keepsWarm(edgeId))) {
            requestRelay(edgeId);
        }
    });
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
    if (edgeId) settleWaiters(edgeId, reason);
    else for (const id of [...waiters.keys()]) settleWaiters(id, reason);
    return closed;
}

const PING_TAG = 0x52;

function measureRoundTrips(): void {
    for (const list of relays.values()) {
        for (const r of list) {
            if (!r.session.open || r.session.size === 0) continue;
            const payload = Buffer.alloc(9);
            payload[0] = PING_TAG;
            payload.writeDoubleBE(performance.now(), 1);
            try {
                r.ws.ping(payload);
            } catch {}
        }
    }
}

function onPong(r: Relay, data: Buffer): void {
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
            if (r.session.size > 0) {
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
