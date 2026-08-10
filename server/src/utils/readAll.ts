import type { Readable } from "node:stream";

export async function readAll(stream: Readable): Promise<Buffer>;
export async function readAll<T extends "text" | "json">(
    stream: Readable,
    format: T,
): Promise<T extends "text" ? string : any>;
export async function readAll(stream: Readable, format?: "text" | "json") {
    let data: Buffer;
    if ((stream as any).readableEnded) {
        const chunk = stream.read();
        data = chunk
            ? Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk)
            : Buffer.alloc(0);
    } else {
        const readPromise = new Promise<Buffer>((resolve, reject) => {
            const body: Uint8Array[] = [];
            stream.on("data", (chunk) => {
                body.push(chunk);
            });
            stream.on("end", () => resolve(Buffer.concat(body)));
            stream.on("error", reject);
            if (typeof (stream as any).resume === "function") {
                (stream as any).resume();
            }
        });
        data = await readPromise;
    }
    switch (format) {
        case "text":
            return data.toString();
        case "json":
            return JSON.parse(data.toString());
        default:
            return data;
    }
}
