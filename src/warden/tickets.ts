import { kv } from "../kv/index.ts";
import { generateToken } from "../utils/token.ts";
import type { Reason } from "../constants.ts";
import type { ActiveTicketData, TicketData } from "./types.ts";

export async function createTicket(
    originWorker: string,
    lifelineWorker: string,
    edgeId: string,
    reqId: string,
    tunnelId: string,
    ttlSeconds: number
): Promise<string> {
    const ticket = generateToken("tmp_");
    const data: ActiveTicketData = {
        originWorker,
        lifelineWorker,
        edgeId,
        reqId,
        tunnelId,
    };
    await kv.set(`relayed_request:${ticket}`, data, ttlSeconds);
    return ticket;
}

export async function claimTicket(ticket: string): Promise<TicketData | null> {
    const claimed = await kv.getdel<TicketData>(`relayed_request:${ticket}`);
    return claimed;
}

export async function cancelTicketTombstone(ticket: string, reason: Reason): Promise<void> {
    await kv.set(`relayed_request:${ticket}`, { status: "cancelled", reason }, 5);
}

export async function deleteTicket(ticket: string): Promise<void> {
    await kv.del(`relayed_request:${ticket}`);
}
