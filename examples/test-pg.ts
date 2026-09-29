import tunnel from "fullstacked/tunnel";
import pg from "pg";

// 1. Establish tunneled socket to external PostgreSQL database using the tunnel token
const host = await tunnel.register({
  host: "localhost:3000",
  authorization: "<pg-tunnel-token>"
});

// 2. Connect using standard PostgreSQL client seamlessly
const pool = new pg.Pool({
  host,
  port: 5432,
  user: "postgres",
  password: "password",
  database: "postgres"
});

const { rows } = await pool.query("SELECT NOW()");
console.log(`Connected to PostgreSQL via FullStacked Tunnels: ${JSON.stringify(rows[0])}`);

await pool.end();

