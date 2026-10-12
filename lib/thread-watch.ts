import "server-only";
import { databasePool } from "./db";
import { WATCH_LIMIT, WATCH_SECONDS, type ThreadHealth } from "./comments";
export async function watchThread(id: number): Promise<ThreadHealth | null> {
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    // A short global lock bounds active subscriptions across concurrent viewers.
    await client.query("SELECT pg_advisory_xact_lock(724194)");
    const known = await client.query(
      "SELECT id FROM hn_items WHERE id=$1 AND type IN ('story','job','poll')",
      [id],
    );
    if (!known.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const active = await client.query(
      "SELECT story_id FROM hn_threads WHERE requested_at>clock_timestamp()-$1::integer*interval '1 second' AND story_id<>$2",
      [WATCH_SECONDS, id],
    );
    if ((active.rowCount ?? 0) >= WATCH_LIMIT) {
      await client.query("ROLLBACK");
      return { state: "busy", checkedAt: null, committedAt: null };
    }
    const { rows } = await client.query(
      `INSERT INTO hn_threads(story_id) VALUES($1)
      ON CONFLICT(story_id) DO UPDATE SET requested_at=clock_timestamp()
      RETURNING state,checked_at,committed_at,truncated`,
      [id],
    );
    const owned = (
      await client.query(
        "SELECT active_until>clock_timestamp() AS owned FROM ingest_leases WHERE id=1",
      )
    ).rows[0]?.owned;
    await client.query("COMMIT");
    const row = rows[0];
    const checkedAt = row.checked_at
      ? new Date(row.checked_at).toISOString()
      : null;
    const fresh =
      checkedAt && Date.now() - Date.parse(checkedAt) < 30000 && owned;
    return {
      state: fresh
        ? row.state
        : row.state === "starting"
          ? "starting"
          : "degraded",
      checkedAt,
      committedAt: row.committed_at,
      truncated: row.truncated,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
