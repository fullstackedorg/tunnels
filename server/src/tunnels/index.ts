import http from "node:http";
import { proxiesTable } from "../entities/schema/proxy";
import { getByToken } from "../entities/index";
import { servicesTable } from "../entities/schema/service";

export type TunnelType = "proxy" | "service";

export async function getRequestTunnelItem(
    req: http.IncomingMessage,
    type: TunnelType,
) {
    const token = req.headers.authorization;

    if (type === "proxy") {
        return getByToken(proxiesTable, token);
    } else {
        return getByToken(servicesTable, token);
    }
}
