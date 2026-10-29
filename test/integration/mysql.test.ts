import test from "node:test";
import { PORTS, CREDENTIALS } from "./helpers/env.ts";
import {
    setupIntegrationHarness,
    createDirectTunnel,
    createRelayedTunnel,
} from "./helpers/hub-edge.ts";
import { runProgrammatic } from "./helpers/runtime.ts";
import { waitForMySQL } from "./helpers/compose.ts";

test("mysql: wire protocol forwarding, transactions, and packet boundaries over direct tunnel", async () => {
    await waitForMySQL();
    const harness = await setupIntegrationHarness(false);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createDirectTunnel(
            harness.hubUrl,
            PORTS.mysql,
            "127.0.0.1",
            "MySQL Direct"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import mysql from "mysql2/promise";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const conn = await mysql.createConnection({
                host,
                port: 3306,
                user: "${CREDENTIALS.mysql.user}",
                password: "${CREDENTIALS.mysql.password}",
                database: "${CREDENTIALS.mysql.database}",
            });

            // 1. DDL: Create table
            await conn.query("DROP TABLE IF EXISTS direct_mysql_test");
            await conn.query(
                "CREATE TABLE direct_mysql_test (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255), payload TEXT)"
            );

            // 2. Transaction: Commit
            await conn.beginTransaction();
            await conn.query("INSERT INTO direct_mysql_test (name, payload) VALUES (?, ?)", [
                "record-1",
                "val-1",
            ]);
            await conn.commit();

            // 3. Transaction: Rollback
            await conn.beginTransaction();
            await conn.query("INSERT INTO direct_mysql_test (name, payload) VALUES (?, ?)", [
                "record-rollback",
                "val-rollback",
            ]);
            await conn.rollback();

            // 4. Packet boundary check (2KB payload)
            const mediumText = "x".repeat(2048);
            await conn.query("INSERT INTO direct_mysql_test (name, payload) VALUES (?, ?)", [
                "medium-record",
                mediumText,
            ]);

            const [rows] = await conn.query(
                "SELECT name, payload FROM direct_mysql_test ORDER BY id ASC"
            );
            assert.equal(rows.length, 2);
            assert.equal(rows[0].name, "record-1");
            assert.equal(rows[1].name, "medium-record");
            assert.equal(rows[1].payload.length, 2048);

            await conn.end();
        `);
    } finally {
        await harness.close();
    }
});

test("mysql: relational database queries over edge relayed tunnel", async () => {
    await waitForMySQL();
    const harness = await setupIntegrationHarness(true);
    const hubPort = parseInt(new URL(harness.hubUrl).port, 10);

    try {
        const { token } = await createRelayedTunnel(
            harness.hubUrl,
            harness.edgeId!,
            PORTS.mysql,
            "127.0.0.1",
            "MySQL Relayed"
        );

        await runProgrammatic(`
            import tunnel from "fullstacked/tunnel";
            import mysql from "mysql2/promise";
            import assert from "assert";

            const host = await tunnel.register({
                host: "127.0.0.1",
                port: ${hubPort},
                authorization: "${token}",
                unsecure: true,
            });

            const conn = await mysql.createConnection({
                host,
                port: 3306,
                user: "${CREDENTIALS.mysql.user}",
                password: "${CREDENTIALS.mysql.password}",
                database: "${CREDENTIALS.mysql.database}",
            });

            const [rows] = await conn.query("SELECT 40 + 2 AS answer");
            assert.equal(rows[0].answer, 42);

            // Verify write and read over relayed tunnel
            await conn.query("DROP TABLE IF EXISTS relayed_mysql_test");
            await conn.query(
                "CREATE TABLE relayed_mysql_test (id INT AUTO_INCREMENT PRIMARY KEY, msg VARCHAR(100))"
            );
            await conn.query("INSERT INTO relayed_mysql_test (msg) VALUES (?)", ["hello-relayed"]);

            const [selected] = await conn.query(
                "SELECT msg FROM relayed_mysql_test WHERE id = 1"
            );
            assert.equal(selected[0].msg, "hello-relayed");

            await conn.end();
        `);
    } finally {
        await harness.close();
    }
});
