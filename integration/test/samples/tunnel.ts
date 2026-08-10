import tunnel from "fullstacked/tunnel";
import { Tunnel } from "../../fullstacked/platform/node/types/@types/tunnel";

export function maybeTunnel(t?: Tunnel) {
    if (t) {
        return tunnel.register(t);
    }
    return undefined;
}