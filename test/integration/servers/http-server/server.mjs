import net from "node:net";
import http from "node:http";
import http2 from "node:http2";

const PORT = parseInt(process.env.PORT || "8080", 10);
const PREFACE = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");

function handleRequest(req, res, urlPath, headers, isH2) {
    const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "*",
        "access-control-allow-headers": "*",
        "access-control-expose-headers": "*",
    };

    const method = isH2 ? String(headers[":method"] || "GET") : String(req.method || "GET");
    if (method === "OPTIONS") {
        if (isH2) {
            res.respond({ ":status": 204, ...corsHeaders });
            res.end();
        } else {
            res.writeHead(204, corsHeaders);
            res.end();
        }
        return;
    }

    if (urlPath === "/health") {
        if (isH2) {
            res.respond({ ":status": 200, "content-type": "text/plain", ...corsHeaders });
            res.end("ok");
        } else {
            res.writeHead(200, { "content-type": "text/plain", ...corsHeaders });
            res.end("ok");
        }
        return;
    }

    if (urlPath === "/echo") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            const echoHeaders = {};
            for (const [k, v] of Object.entries(headers)) {
                if (!k.startsWith(":")) {
                    echoHeaders[`x-echo-${k}`] = String(v);
                }
            }
            if (isH2) {
                res.respond({
                    ":status": 200,
                    "content-type": headers["content-type"] || "application/octet-stream",
                    "x-response-server": "fullstacked-http-server",
                    ...corsHeaders,
                    ...echoHeaders,
                });
                res.end(body);
            } else {
                res.writeHead(200, {
                    "content-type": headers["content-type"] || "application/octet-stream",
                    "x-response-server": "fullstacked-http-server",
                    ...corsHeaders,
                    ...echoHeaders,
                });
                res.end(body);
            }
        });
        return;
    }

    if (urlPath === "/chunked") {
        if (isH2) {
            res.respond({ ":status": 200, "content-type": "text/plain", ...corsHeaders });
        } else {
            res.writeHead(200, {
                "content-type": "text/plain",
                "transfer-encoding": "chunked",
                ...corsHeaders,
            });
        }
        res.write("chunk-1\n");
        setTimeout(() => {
            res.write("chunk-2\n");
            setTimeout(() => {
                res.write("chunk-3\n");
                res.end();
            }, 30);
        }, 30);
        return;
    }

    if (urlPath === "/sse") {
        if (isH2) {
            res.respond({
                ":status": 200,
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                ...corsHeaders,
            });
        } else {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
                ...corsHeaders,
            });
        }
        res.write("id: 1\nevent: notice\ndata: sse-message-1\n\n");
        setTimeout(() => {
            res.write("id: 2\nevent: notice\ndata: sse-message-2\n\n");
            setTimeout(() => {
                res.write("id: 3\nevent: notice\ndata: sse-message-3\n\n");
                res.end();
            }, 30);
        }, 30);
        return;
    }

    if (urlPath === "/stream") {
        if (isH2) {
            res.respond({
                ":status": 200,
                "content-type": "application/octet-stream",
                ...corsHeaders,
            });
        } else {
            res.writeHead(200, { "content-type": "application/octet-stream", ...corsHeaders });
        }
        req.pipe(res);
        return;
    }

    if (isH2) {
        res.respond({ ":status": 404, "content-type": "text/plain", ...corsHeaders });
        res.end("not found");
    } else {
        res.writeHead(404, { "content-type": "text/plain", ...corsHeaders });
        res.end("not found");
    }
}

const h1Server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    handleRequest(req, res, url.pathname, req.headers, false);
});

const h2Server = http2.createServer();
h2Server.on("stream", (stream, headers) => {
    const path = String(headers[":path"] || "/");
    const pathname = path.split("?")[0];
    handleRequest(stream, stream, pathname, headers, true);
});

const gateway = net.createServer((socket) => {
    socket.once("readable", () => {
        const chunk = socket.read(24);
        if (!chunk) return;
        socket.unshift(chunk);
        if (chunk.equals(PREFACE)) {
            h2Server.emit("connection", socket);
        } else {
            h1Server.emit("connection", socket);
        }
    });
});

gateway.listen(PORT, "0.0.0.0", () => {
    console.log(`Dual HTTP/1.1 and HTTP/2 server listening on port ${PORT}`);
});
