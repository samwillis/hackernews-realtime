import type { Pool } from "pg";
import { WATCH_SECONDS, type ThreadHealth } from "../lib/comments";

export async function updateThreadView(
  pool: Pool,
  id: number,
  viewer?: string,
  released = false,
): Promise<ThreadHealth | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const known = await client.query(
      "SELECT id FROM hn_items WHERE id=$1 AND type IN ('story','job','poll')",
      [id],
    );
    if (!known.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      "INSERT INTO hn_threads(story_id,requested_at) VALUES($1,'-infinity') ON CONFLICT DO NOTHING",
      [id],
    );
    if (viewer) {
      // A release wins even when an earlier renewal arrives afterwards.
      await client.query(
        `INSERT INTO hn_thread_views(viewer_id,story_id,released) VALUES($1,$2,$3)
         ON CONFLICT(viewer_id,story_id) DO UPDATE SET requested_at=clock_timestamp(),
         released=hn_thread_views.released OR EXCLUDED.released`,
        [viewer, id, released],
      );
    } else {
      // Old deployed tabs only send an ID. Keep a short lease until reload.
      await client.query(
        "UPDATE hn_threads SET requested_at=clock_timestamp() WHERE story_id=$1",
        [id],
      );
    }
    const { rows } = await client.query(
      `SELECT state,checked_at,committed_at,truncated,
       EXISTS(SELECT 1 FROM ingest_leases WHERE id=1 AND active_until>clock_timestamp()) AS owned
       FROM hn_threads WHERE story_id=$1`,
      [id],
    );
    await client.query("COMMIT");
    const row = rows[0];
    const checkedAt = row.checked_at
      ? new Date(row.checked_at).toISOString()
      : null;
    const fresh =
      checkedAt && Date.now() - Date.parse(checkedAt) < 30000 && row.owned;
    return {
      state: fresh
        ? row.state
        : row.state === "starting"
          ? "starting"
          : "degraded",
      checkedAt,
      committedAt: row.committed_at
        ? new Date(row.committed_at).toISOString()
        : null,
      truncated: row.truncated,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function watchedThreads(pool: Pool): Promise<number[]> {
  const { rows } = await pool.query(
    `SELECT story_id FROM hn_threads t
     WHERE requested_at>clock_timestamp()-$1::integer*interval '1 second'
     OR EXISTS(SELECT 1 FROM hn_thread_views v WHERE v.story_id=t.story_id AND NOT v.released
       AND v.requested_at>clock_timestamp()-$1::integer*interval '1 second')
     ORDER BY story_id`,
    [WATCH_SECONDS],
  );
  return rows.map((row) => row.story_id);
}
