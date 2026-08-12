import { proxiesTable } from "../entities/schema/proxy";
import { getByToken } from "../entities/index";
import { servicesTable } from "../entities/schema/service";
import { IncomingMessageWithDeny } from "../http";

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
