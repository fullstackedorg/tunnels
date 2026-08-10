import { pgTable, uuid, text, integer } from "drizzle-orm/pg-core";
import { machinesTable } from "./machine";
import crypto from "node:crypto";

export const servicesTable = pgTable("services", {
    id: uuid("id").primaryKey().defaultRandom().$type<crypto.UUID>(),
    token: text("token").notNull(),
    name: text("name").notNull(),
    internalHost: text("internal_host").notNull(),
    internalPort: integer("internal_port").notNull(),
    machineId: uuid("machineid")
        .references(() => machinesTable.id)
        .$type<crypto.UUID>(),
});

export type Service = typeof servicesTable.$inferSelect;
