import { pgTable, uuid, text } from "drizzle-orm/pg-core";
import crypto from "node:crypto";

export const machinesTable = pgTable("machines", {
    id: uuid("id").primaryKey().defaultRandom().$type<crypto.UUID>(),
    token: text("token").notNull(),
    name: text("name").notNull(),
    version: text("version"),
});

export type Machine = typeof machinesTable.$inferSelect;
