import * as ws from "ws";
import http from "node:http";

const wss = new ws.WebSocketServer({ noServer: true });

export function upgradeRequest(req: http.IncomingMessage) {
    return new Promise<ws.WebSocket>((res) => {
        wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (websocket) => {
            websocket.emit("connection", websocket, req);
            res(websocket);
        });
    });
}

export const createWebSocketStream = ws.createWebSocketStream;
