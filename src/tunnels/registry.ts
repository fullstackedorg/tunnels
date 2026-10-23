import type { Reason } from "../constants.ts";
import { CLOSE_CODES } from "../constants.ts";

export interface ActiveSession {
    id: string;
    tunnelId: string;
    edgeId?: string | null;
    close: (code: number, reason: Reason) => void;
}

const activeSessions = new Map<string, ActiveSession>();
let clusterIpcSender: ((msg: any) => void) | null = null;

export function setTunnelRegistryIpcSender(sender: ((msg: any) => void) | null): void {
    clusterIpcSender = sender;
}

export function registerSession(session: ActiveSession): () => void {
    activeSessions.set(session.id, session);
    return () => {
        activeSessions.delete(session.id);
    };
}

export function unregisterSession(sessionId: string): void {
    activeSessions.delete(sessionId);
}

export function getActiveSessionCount(): number {
    return activeSessions.size;
}

let severEdgeListener: ((edgeId: string, reason: Reason) => void) | null = null;

/** Called when an Edge's sessions are severed on this worker (its relay sessions close too). */
export function setSeverEdgeListener(fn: ((edgeId: string, reason: Reason) => void) | null): void {
    severEdgeListener = fn;
}

/**
 * Severs are remembered for SEVER_MEMORY_MS: a session whose token resolved before a sever (the
 * old entity) and that registers after it is closed with the same reason. Longer than any
 * upgrade takes to set up (token resolution, gating hooks); one older than that is refused.
 */
export const SEVER_MEMORY_MS = 5 * 60_000;
const recentSevers = new Map<string, { at: number; reason: Reason }>();

function rememberSever(filter: { tunnelId?: string; edgeId?: string }, reason: Reason): void {
    const now = Date.now();
    for (const [key, sever] of recentSevers) {
        if (now - sever.at > SEVER_MEMORY_MS) recentSevers.delete(key);
    }
    if (filter.tunnelId) recentSevers.set(`tunnel:${filter.tunnelId}`, { at: now, reason });
    if (filter.edgeId) recentSevers.set(`edge:${filter.edgeId}`, { at: now, reason });
}

/**
 * The reason a session set up from a token resolved at `resolvedAt` (ms since epoch, comparable
 * across workers) must close with: a sever of its tunnel or Edge since then, else null.
 */
export function severedSince(
    resolvedAt: number | undefined,
    ids: { tunnelId?: string; edgeId?: string | null }
): Reason | null {
    if (resolvedAt === undefined) return null;
    if (Date.now() - resolvedAt > SEVER_MEMORY_MS) return "stream_error";
    for (const key of [`tunnel:${ids.tunnelId}`, `edge:${ids.edgeId}`]) {
        const sever = recentSevers.get(key);
        if (sever && sever.at >= resolvedAt) return sever.reason;
    }
    return null;
}

export function severLocalSessions(
    filter: { tunnelId?: string; edgeId?: string },
    reason: Reason = "token_rolled"
): number {
    let severed = 0;
    rememberSever(filter, reason);
    const code = CLOSE_CODES[reason] ?? 1000;
    if (filter.edgeId && !filter.tunnelId) severEdgeListener?.(filter.edgeId, reason);

    for (const [id, session] of activeSessions.entries()) {
        if (filter.tunnelId && session.tunnelId !== filter.tunnelId) {
            continue;
        }
        if (filter.edgeId && session.edgeId !== filter.edgeId) {
            continue;
        }
        if (!filter.tunnelId && !filter.edgeId) {
            continue;
        }
        activeSessions.delete(id);
        try {
            session.close(code, reason);
        } catch {
            // ignore
        }
        severed++;
    }
    return severed;
}

export function severAllLocalSessions(reason: Reason = "hub_shutdown"): number {
    let severed = 0;
    const code = CLOSE_CODES[reason] ?? 1000;
    for (const [id, session] of activeSessions.entries()) {
        activeSessions.delete(id);
        try {
            session.close(code, reason);
        } catch {
            // ignore
        }
        severed++;
    }
    return severed;
}

export async function severSessions(
    filter: { tunnelId?: string; edgeId?: string },
    reason: Reason = "token_rolled"
): Promise<number> {
    const localCount = severLocalSessions(filter, reason);

    if (clusterIpcSender) {
        clusterIpcSender({
            type: "sever_sessions",
            tunnelId: filter.tunnelId,
            edgeId: filter.edgeId,
            reason,
        });
    }

    return localCount;
}

export function handleSeverSessionsIpc(msg: any): void {
    if (msg && msg.type === "sever_sessions") {
        severLocalSessions(
            { tunnelId: msg.tunnelId, edgeId: msg.edgeId },
            msg.reason || "token_rolled"
        );
    }
}
