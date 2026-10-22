/** TCP echo target for the load bench, run in its own process so its CPU is not the hub's. */
import net from "node:net";

const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on("error", () => {});
    socket.pipe(socket);
});
server.listen(0, "127.0.0.1", () => {
    process.send?.({ type: "ready", port: (server.address() as net.AddressInfo).port });
});
process.on("disconnect", () => process.exit(0));
