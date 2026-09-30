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

export function severLocalSessions(
    filter: { tunnelId?: string; edgeId?: string },
    reason: Reason = "token_rolled"
): number {
    let severed = 0;
    const code = CLOSE_CODES[reason] ?? 1000;

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
