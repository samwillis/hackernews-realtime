import { Pool } from "pg";
import { runSession } from "../ingest/session";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 10000,
  statement_timeout: 10000,
});
try {
  do {
    console.log(
      await runSession(pool, {
        budgetMs: Number(process.env.INGEST_REQUEST_BUDGET_MS ?? 240000),
        tenureMs: Number(process.env.INGEST_TENURE_MS ?? 120000),
        overlapMs: Number(process.env.INGEST_OVERLAP_MS ?? 90000),
        smoothingMs: Number(process.env.INGEST_SMOOTHING_MS ?? 28000),
      }),
    );
    if (!process.argv.includes("--watch")) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (true);
} finally {
  await pool.end();
}
