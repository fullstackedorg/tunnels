import net from "node:net";
import { classifyDialError } from "../utils/net.ts";

export async function connectDirectTarget(
    internalHost: string,
    internalPort: number,
    deadline: number,
    signal?: AbortSignal
): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
        let isSettled = false;
        const onAbort = () => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            socket.destroy();
            const err: any = new Error("Direct dial aborted");
            err.reason = signal?.reason;
            reject(err);
        };
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

        if (signal?.aborted) onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });

        socket.once("connect", () => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            socket.setKeepAlive(true, 60000);
            socket.pause();
            resolve(socket);
        });

        socket.on("error", (err: any) => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            socket.destroy();
            err.reason = classifyDialError(err);
            reject(err);
        });
    });
}
