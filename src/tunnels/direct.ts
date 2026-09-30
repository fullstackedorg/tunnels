import net from "node:net";

export async function connectDirectTarget(
    internalHost: string,
    internalPort: number,
    deadline: number
): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
        let isSettled = false;
        const msRemaining = Math.max(1, deadline - Date.now());

        const socket = net.createConnection({
            host: internalHost,
            port: internalPort,
        });

        const timer = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            socket.destroy();
            const err: any = new Error("Connect timeout to target");
            err.reason = "connect_timeout";
            reject(err);
        }, msRemaining);

        socket.once("connect", () => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            socket.setKeepAlive(true, 60000);
            socket.pause();
            resolve(socket);
        });

        socket.on("error", (err: any) => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            socket.destroy();
            const failureReason =
                err.code === "ECONNREFUSED" ||
                err.code === "EHOSTUNREACH" ||
                err.code === "ENOTFOUND"
                    ? "target_unreachable"
                    : "connect_timeout";
            err.reason = failureReason;
            reject(err);
        });
    });
}
