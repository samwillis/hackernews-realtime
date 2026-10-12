import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { readHn, mapLimit, type HnItem } from "./hn-api";
import {
  orderedComments,
  selectComments,
  type ThreadSnapshot,
} from "./comment-tree";
import { publishThread } from "./thread-store";

type Reader = (path: string, signal?: AbortSignal) => Promise<HnItem | null>;
export async function firstComments(
  id: number,
  read: Reader = readHn,
): Promise<ThreadSnapshot> {
  // Load a small parallel batch; first render needn't wait for the whole tree.
  const signal = AbortSignal.timeout(4500);
  const root = await read(`item/${id}`, signal);
  if (!root || !["story", "job", "poll"].includes(root.type ?? ""))
    throw new Error("HN story is unavailable");
  const ids = selectComments(root, new Map()).ids.slice(0, 20);
  const pairs = await mapLimit(
    ids,
    20,
    async (childId) =>
      [
        childId,
        (await read(`item/${childId}`, signal)) ?? {
          id: childId,
          deleted: true,
        },
      ] as const,
  );
  const items = new Map(pairs);
  const selected = selectComments(root, items);
  return {
    story: root,
    rows: orderedComments(root, items),
    truncated: selected.truncated,
    receivedAt: Date.now(),
    complete: selected.ids.every((childId) => items.has(childId)),
  };
}

// A DB claim deduplicates cold loads across web instances. Never hold a pool
// connection over HN requests. A newer worker publication wins the seed race.
export async function loadThread(pool: Pool, id: number, read?: Reader) {
  const owner = randomUUID();
  const deadline = Date.now() + 5500;
  while (true) {
    const claim = await pool.query(
      `INSERT INTO hn_threads(story_id,requested_at,initial_load_owner,initial_load_until)
       SELECT id,'-infinity',$2,clock_timestamp()+interval '8 seconds' FROM hn_items
       WHERE id=$1 AND type IN ('story','job','poll')
       ON CONFLICT(story_id) DO UPDATE SET initial_load_owner=$2,initial_load_until=clock_timestamp()+interval '8 seconds'
       WHERE hn_threads.loaded_at IS NULL AND (hn_threads.initial_load_until IS NULL OR hn_threads.initial_load_until<clock_timestamp())
       RETURNING story_id`,
      [id, owner],
    );
    if (claim.rowCount) break;
    const current = (
      await pool.query("SELECT loaded_at FROM hn_threads WHERE story_id=$1", [
        id,
      ])
    ).rows[0];
    if (!current || current.loaded_at || Date.now() >= deadline) return;
    await delay(150);
  }
  try {
    const snapshot = await firstComments(id, read);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT 1 FROM hn_threads WHERE story_id=$1 AND initial_load_owner=$2
         AND initial_load_until>clock_timestamp() AND loaded_at IS NULL FOR UPDATE`,
        [id, owner],
      );
      if (current.rowCount)
        await publishThread(client, snapshot, new Date().toISOString());
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.query(
      "UPDATE hn_threads SET initial_load_owner=NULL,initial_load_until=NULL WHERE story_id=$1 AND initial_load_owner=$2",
      [id, owner],
    );
  }
}
