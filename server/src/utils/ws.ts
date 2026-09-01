import * as ws from "ws";
import type { IncomingMessageWithDeny } from "../http/index.ts";

const wss = new ws.WebSocketServer({ noServer: true });

export function upgradeRequest(req: IncomingMessageWithDeny) {
    return new Promise<ws.WebSocket>((res) => {
        wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (websocket) => {
            websocket.emit("connection", websocket, req);
            res(websocket);
        });
    });
}

export const createWebSocketStream = ws.createWebSocketStream;
