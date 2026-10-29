import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/entities/schema.ts",
    out: "./drizzle",
    // drizzle-kit push targets the same database as the Hub: set POSTGRES_URL when running it.
    dbCredentials: { url: process.env.POSTGRES_URL ?? "" },
});
