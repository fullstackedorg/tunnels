import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/entities/schema.ts",
    out: "./drizzle",
});
