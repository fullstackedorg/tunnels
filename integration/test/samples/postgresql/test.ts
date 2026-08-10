import pg from "pg"

export async function testPostgreSQL(
    port: number,
    user: string,
    password: string,
    testData: {
        postgresql: string
    },
    host = "localhost"
) {
    const client = new pg.Client({
        host,
        user,
        password,
        port,
        database: "postgres"
    });

    await client.connect();

    const tableName = testData.postgresql;

    await client.query(`CREATE TABLE IF NOT EXISTS "${tableName}" (id SERIAL PRIMARY KEY, payload JSONB);`);
    await client.query(`INSERT INTO "${tableName}" (payload) VALUES ($1);`, [JSON.stringify(testData)]);

    const res = await client.query(`SELECT payload FROM "${tableName}" ORDER BY id DESC LIMIT 1;`);
    await client.end();
    return res.rows[0].payload;
}