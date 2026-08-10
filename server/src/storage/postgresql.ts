import { getEnvOrArgCLI } from "../utils/args";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

let db: ReturnType<typeof drizzle> | null = null;
export async function initPostgreSQL() {
    const config = getEnvOrArgCLI(["POSTGRES_URL", "postgres-url"], "string");

    if (!config) {
        return false;
    }

    const client = new Pool({
        connectionString: config,
    });

    await client.connect();
    await client.query("SELECT 1");

    db = drizzle({ client });

    return true;
}

export function getDb() {
    if (!db) {
        throw new Error("PostgreSQL not initialized");
    }
    return db;
}
