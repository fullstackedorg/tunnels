import { proxiesTable } from "../entities/schema/proxy.ts";
import { getByToken } from "../entities/index.ts";
import { servicesTable } from "../entities/schema/service.ts";
import type { IncomingMessageWithDeny } from "../http/index.ts";

export type TunnelType = "proxy" | "service";

export async function getRequestTunnelItem(
    req: IncomingMessageWithDeny,
    type: TunnelType,
) {
    const token = req.headers.authorization;

    if (type === "proxy") {
        return getByToken(proxiesTable, token);
    } else {
        return getByToken(servicesTable, token);
    }
}
