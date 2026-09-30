import test from "node:test";
import { PORTS, CREDENTIALS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runProgrammatic } from "./helpers/runtime.ts";
import { waitForPostgres } from "./helpers/compose.ts";

test("postgres: connection pooling, DDL, DML, and transactions over direct tunnel", async () => {
    await waitForPostgres();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.postgres,
            "127.0.0.1",
            "Postgres Direct"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import pg from "pg";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const pool = new pg.Pool({
                host,
                port: 5432,
                user: "${CREDENTIALS.postgres.user}",
                password: "${CREDENTIALS.postgres.password}",
                database: "${CREDENTIALS.postgres.database}",
                max: 5,
            });

            // 1. DDL & Schema Migration
            await pool.query("DROP TABLE IF EXISTS direct_pg_test");
            await pool.query(
                "CREATE TABLE direct_pg_test (id SERIAL PRIMARY KEY, title TEXT, metadata JSONB)"
            );

            // 2. Transaction with JSONB
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query("INSERT INTO direct_pg_test (title, metadata) VALUES ($1, $2)", [
                    "item-1",
                    JSON.stringify({ author: "Alice", tags: ["a", "b"] }),
                ]);
                await client.query("COMMIT");
            } finally {
                client.release();
            }

            // 3. Query JSONB operators
            const res = await pool.query(
                "SELECT title, metadata->>'author' AS author FROM direct_pg_test WHERE metadata->'tags' ? 'b'"
            );
            assert.equal(res.rows.length, 1);
            assert.equal(res.rows[0].author, "Alice");

            // 4. Concurrent pool queries
            const results = await Promise.all(
                Array.from({ length: 5 }, (_, i) => pool.query("SELECT $1::int AS val", [i]))
            );
            for (let i = 0; i < 5; i++) {
                assert.equal(results[i].rows[0].val, i);
            }

            await pool.end();
        `);
    } finally {
        await harness.close();
    }
});

test("postgres: transactions and connection pooling over edge relayed tunnel", async () => {
    await waitForPostgres();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.postgres,
            "127.0.0.1",
            "Postgres Relayed"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import pg from "pg";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const pool = new pg.Pool({
                host,
                port: 5432,
                user: "${CREDENTIALS.postgres.user}",
                password: "${CREDENTIALS.postgres.password}",
                database: "${CREDENTIALS.postgres.database}",
                max: 3,
            });

            const res = await pool.query("SELECT 100 + 200 AS sum");
            assert.equal(res.rows[0].sum, 300);

            await pool.query("DROP TABLE IF EXISTS relayed_pg_test");
            await pool.query("CREATE TABLE relayed_pg_test (id SERIAL PRIMARY KEY, note TEXT)");
            await pool.query("INSERT INTO relayed_pg_test (note) VALUES ('relayed-ok')");

            const check = await pool.query("SELECT note FROM relayed_pg_test WHERE id = 1");
            assert.equal(check.rows[0].note, "relayed-ok");

            await pool.end();
        `);
    } finally {
        await harness.close();
    }
});
