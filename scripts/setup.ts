import { migrate } from "../ingest/migrate";
import { Pool } from "pg";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  max: 1,
});
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await migrate(client);
    await client.query("COMMIT");
    console.log("HN schema ready.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
