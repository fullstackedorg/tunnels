import { pgTable, uuid, text, json, integer } from "drizzle-orm/pg-core";
import crypto from "node:crypto";

export const proxiesTable = pgTable("proxies", {
    id: uuid("id").primaryKey().defaultRandom().$type<crypto.UUID>(),
    token: text("token").notNull(),
    name: text("name").notNull(),
    urlProtocol: text("url_protocol").notNull(),
    urlHost: text("url_host").notNull(),
    urlPort: integer("url_port"),
    headers: json("headers").$type<Record<string, string>>(),
});

export type Proxy = typeof proxiesTable.$inferSelect;
