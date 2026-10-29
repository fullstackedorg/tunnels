import { pgTable, uuid, text, integer, jsonb } from "drizzle-orm/pg-core";

export interface Edge {
    id: string;
    token: string;
    name: string;
    version: string | null;
    metadata: Record<string, any>;
    connected?: boolean;
    lastSeen?: number | null;
}

export interface Tunnel {
    id: string;
    token: string;
    name: string;
    internalHost: string;
    internalPort: number;
    edgeId: string | null;
    metadata: Record<string, any>;
}

export const edgeTable = pgTable("edge", {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    name: text("name").notNull(),
    version: text("version"),
    metadata: jsonb("metadata").notNull().default({}),
});

export const tunnelTable = pgTable("tunnel", {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    name: text("name").notNull(),
    internalHost: text("internal_host").notNull(),
    internalPort: integer("internal_port").notNull(),
    edgeId: uuid("edge_id").references(() => edgeTable.id, { onDelete: "cascade" }),
    metadata: jsonb("metadata").notNull().default({}),
});
