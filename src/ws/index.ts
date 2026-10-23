import { WebSocketServer } from "ws";
export * from "./heartbeat.ts";

/**
 * Largest WebSocket message either node accepts: a mux frame is at most 5 + 32 KiB (an OPEN
 * carries at most a tunnel's 16 KB metadata), lifeline orders are a few bytes. A bigger frame
 * closes the WebSocket with 1009 before it is buffered (ws defaults to 100 MiB).
 */
export const MAX_WS_PAYLOAD = 64 * 1024;

export function createWebSocketServer(): WebSocketServer {
    return new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
        maxPayload: MAX_WS_PAYLOAD,
    });
}
