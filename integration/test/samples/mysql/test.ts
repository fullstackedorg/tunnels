import mysql from "mysql2/promise";

export async function testMySQL(
    port: number,
    password: string,
    testData: { mysql: string },
    host = "localhost"
) {
    const connection = await mysql.createConnection({
        host,
        port,
        user: "root",
        password,
    });

    const dbName = "testdb";
    const tableName = testData.mysql;

    await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbName};`);
    await connection.query(`USE ${dbName};`);
    await connection.query(`CREATE TABLE IF NOT EXISTS \`${tableName}\` (id INT AUTO_INCREMENT PRIMARY KEY, payload JSON);`);
    await connection.query(`INSERT INTO \`${tableName}\` (payload) VALUES (?);`, [JSON.stringify(testData)]);

    const [rows]: any = await connection.query(`SELECT payload FROM \`${tableName}\` ORDER BY id DESC LIMIT 1;`);
    await connection.end();
    return rows[0]?.payload;
}
