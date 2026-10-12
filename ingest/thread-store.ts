import type { PoolClient } from "pg";
import { THREAD_LIMIT } from "../lib/comments";
import type { ThreadSnapshot } from "./threads";
export async function publishThread(
  client: PoolClient,
  thread: ThreadSnapshot,
  committedAt: string,
) {
  const ids = thread.rows.map((row) => row.item.id);
  if (
    ids.length > THREAD_LIMIT ||
    new Set(ids).size !== ids.length ||
    thread.rows.some(
      (row) => row.parentId !== thread.story.id && !ids.includes(row.parentId),
    )
  )
    throw new Error("Invalid thread snapshot");
  const records = thread.rows.map((row) => ({
    story_id: thread.story.id,
    item_id: row.item.id,
    parent_id: row.parentId,
    path: row.path,
    depth: row.depth,
    author: row.item.by ?? null,
    created: row.item.time ?? 0,
    text: row.item.text ?? "",
    deleted: Boolean(row.item.deleted),
    dead: Boolean(row.item.dead),
    committed_at: committedAt,
  }));
  const removed = await client.query(
    "DELETE FROM hn_comments WHERE story_id=$1 AND NOT(item_id=ANY($2::integer[]))",
    [thread.story.id, ids],
  );
  const written = await client.query(
    `INSERT INTO hn_comments SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS x(story_id integer,item_id integer,parent_id integer,path text,depth integer,author text,created integer,text text,deleted boolean,dead boolean,committed_at text)
    ON CONFLICT(story_id,item_id) DO UPDATE SET parent_id=EXCLUDED.parent_id,path=EXCLUDED.path,depth=EXCLUDED.depth,
    author=EXCLUDED.author,created=EXCLUDED.created,text=EXCLUDED.text,deleted=EXCLUDED.deleted,dead=EXCLUDED.dead,committed_at=EXCLUDED.committed_at
    WHERE (hn_comments.parent_id,hn_comments.path,hn_comments.depth,hn_comments.author,hn_comments.created,hn_comments.text,hn_comments.deleted,hn_comments.dead)
    IS DISTINCT FROM (EXCLUDED.parent_id,EXCLUDED.path,EXCLUDED.depth,EXCLUDED.author,EXCLUDED.created,EXCLUDED.text,EXCLUDED.deleted,EXCLUDED.dead)`,
    [JSON.stringify(records)],
  );
  const changed = (removed.rowCount ?? 0) + (written.rowCount ?? 0);
  await client.query(
    `UPDATE hn_threads SET state='healthy',checked_at=clock_timestamp(),truncated=$2,
    committed_at=CASE WHEN $3>0 THEN clock_timestamp() ELSE committed_at END WHERE story_id=$1`,
    [thread.story.id, thread.truncated, changed],
  );
  return changed;
}
