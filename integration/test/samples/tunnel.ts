import tunnel from "fullstacked/tunnel";
import type { Tunnel } from "../../fullstacked/platform/node/types/@types/tunnel.d.ts";

export function maybeTunnel(t?: Tunnel) {
    if (t) {
        return tunnel.register(t);
    }
    return undefined;
}