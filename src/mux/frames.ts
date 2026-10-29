/**
 * Multiplexed tunnel sessions: every binary WebSocket message is one frame,
 * `[type u8][stream id u32 BE][payload]`. The side that opens a stream picks its id (never reused
 * within a session); the other side only answers on it. See docs/1-concepts/protocol-spec.md.
 */

export const FRAME_OPEN = 1; // open a stream; payload: empty (runtime) or "host:port" (Edge leg)
export const FRAME_OPENED = 2; // the target is dialed, data flows
export const FRAME_DATA = 3; // stream bytes
export const FRAME_WINDOW = 4; // payload u32 BE: bytes the sender may send more
export const FRAME_FIN = 5; // no more data from this side (half-close)
export const FRAME_RESET = 6; // abort the stream; payload: reason (utf-8)

export const HEADER_SIZE = 5;

/**
 * Send credit of a stream in each direction once OPENED is exchanged, renewed by WINDOW frames.
 * Before OPENED a stream's credit is only PRE_OPEN_WINDOW (early data, held until the target is
 * dialed); OPENED itself grants the rest, with no WINDOW frame.
 */
export const STREAM_WINDOW = 256 * 1024;
export const PRE_OPEN_WINDOW = 32 * 1024;

/** Largest DATA payload: big writes go out in several frames so streams interleave. */
export const MAX_DATA_PAYLOAD = 32 * 1024;

export interface Frame {
    type: number;
    id: number;
    payload: Buffer;
}

export function encodeFrame(type: number, id: number, payload?: Buffer | string): Buffer {
    const body =
        payload === undefined
            ? Buffer.alloc(0)
            : typeof payload === "string"
              ? Buffer.from(payload, "utf-8")
              : payload;
    const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length);
    frame.writeUInt8(type, 0);
    frame.writeUInt32BE(id >>> 0, 1);
    body.copy(frame, HEADER_SIZE);
    return frame;
}

export function encodeWindow(id: number, increment: number): Buffer {
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt32BE(increment >>> 0, 0);
    return encodeFrame(FRAME_WINDOW, id, payload);
}

/** Null for a message too short to be a frame or of an unknown type. */
export function decodeFrame(message: Buffer): Frame | null {
    if (message.length < HEADER_SIZE) return null;
    const type = message.readUInt8(0);
    if (type < FRAME_OPEN || type > FRAME_RESET) return null;
    return { type, id: message.readUInt32BE(1), payload: message.subarray(HEADER_SIZE) };
}
