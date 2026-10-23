import { WebSocketServer } from "ws";
export * from "./heartbeat.ts";

export function createWebSocketServer(): WebSocketServer {
    return new WebSocketServer({
        noServer: true,
        perMessageDeflate: false,
    });
}
