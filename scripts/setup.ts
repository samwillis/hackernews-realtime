import { readFile } from "node:fs/promises";
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
    await client.query(
      await readFile(
        new URL("../migrations/0001_hn.sql", import.meta.url),
        "utf8",
      ),
    );
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
