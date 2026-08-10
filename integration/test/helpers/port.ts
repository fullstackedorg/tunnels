import net from "node:net";

export function randomPort(): number {
    const server = net.createServer();
    server.listen(0);
    const port = (server.address() as net.AddressInfo).port;
    server.close();
    return port;
}