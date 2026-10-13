import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { parseTriggerDelivery } from "@neon/functions/triggers";
import { runSession } from "../ingest/session";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 10000,
  statement_timeout: 10000,
});
attachDatabasePool(pool);
export default {
  async fetch(request: Request) {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 });
    const delivery = await parseTriggerDelivery(request);
    if (!delivery.ok || delivery.invocation.type !== "schedule")
      return new Response("Verified schedule delivery required", {
        status: 403,
      });
    try {
      const result = await runSession(pool, {
        owner: delivery.invocation.invocationId,
        signal: request.signal,
        budgetMs: Number(process.env.INGEST_REQUEST_BUDGET_MS ?? 240000),
        tenureMs: Number(process.env.INGEST_TENURE_MS ?? 120000),
        overlapMs: Number(process.env.INGEST_OVERLAP_MS ?? 90000),
        smoothingMs: Number(process.env.INGEST_SMOOTHING_MS ?? 28000),
      });
      return Response.json(result);
    } catch {
      return Response.json(
        {
          error:
            "Ingestion session ended; the next scheduled delivery will recover.",
        },
        { status: 503 },
      );
    }
  },
};
