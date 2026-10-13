import type { PoolClient } from "pg";
import { THREAD_LIMIT } from "../lib/comments";
import type { ThreadSnapshot } from "./comment-tree";
export function validateThread(thread: ThreadSnapshot) {
  const ids = thread.rows.map((row) => row.item.id);
  if (
    ids.length > THREAD_LIMIT ||
    new Set(ids).size !== ids.length ||
    thread.rows.some(
      (row) => row.parentId !== thread.story.id && !ids.includes(row.parentId),
    )
  )
    throw new Error("Invalid thread snapshot");
}

export function commentRecords(thread: ThreadSnapshot, committedAt: string) {
  return thread.rows.map((row) => ({
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
}
export type CommentRecord = ReturnType<typeof commentRecords>[number];

export async function publishComment(
  client: PoolClient,
  row: CommentRecord,
  committedAt: string,
) {
  // Structure jobs insert parents and descendants together. Content jobs only
  // update existing rows, so a delayed edit cannot resurrect a removed reply.
  const result = await client.query(
    `UPDATE hn_comments SET author=$3,created=$4,text=$5,deleted=$6,dead=$7,committed_at=$8
    WHERE story_id=$1 AND item_id=$2 AND (author,created,text,deleted,dead)
    IS DISTINCT FROM ($3::text,$4::integer,$5::text,$6::boolean,$7::boolean)`,
    [
      row.story_id,
      row.item_id,
      row.author,
      row.created,
      row.text,
      row.deleted,
      row.dead,
      committedAt,
    ],
  );
  if (result.rowCount)
    await client.query(
      "UPDATE hn_threads SET committed_at=clock_timestamp() WHERE story_id=$1",
      [row.story_id],
    );
  return result.rowCount ?? 0;
}

export async function publishThread(
  client: PoolClient,
  thread: ThreadSnapshot,
  committedAt: string,
  structureOnly = false,
) {
  validateThread(thread);
  const ids = thread.rows.map((row) => row.item.id);
  // Serialize cold-page seeds with the worker. Incomplete trees only add rows.
  const locked = await client.query(
    "SELECT story_id FROM hn_threads WHERE story_id=$1 FOR UPDATE",
    [thread.story.id],
  );
  if (!locked.rowCount) throw new Error("Thread is not registered");
  const complete = thread.complete !== false;
  const records = commentRecords(thread, committedAt);
  const removed = complete
    ? await client.query(
        "DELETE FROM hn_comments WHERE story_id=$1 AND NOT(item_id=ANY($2::integer[]))",
        [thread.story.id, ids],
      )
    : { rowCount: 0 };
  const written = await client.query(
    `INSERT INTO hn_comments SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS x(story_id integer,item_id integer,parent_id integer,path text,depth integer,author text,created integer,text text,deleted boolean,dead boolean,committed_at text)
    ON CONFLICT(story_id,item_id) ${
      !complete
        ? "DO NOTHING"
        : structureOnly
          ? `DO UPDATE SET parent_id=EXCLUDED.parent_id,path=EXCLUDED.path,depth=EXCLUDED.depth,committed_at=EXCLUDED.committed_at
    WHERE (hn_comments.parent_id,hn_comments.path,hn_comments.depth)
    IS DISTINCT FROM (EXCLUDED.parent_id,EXCLUDED.path,EXCLUDED.depth)`
          : `DO UPDATE SET parent_id=EXCLUDED.parent_id,path=EXCLUDED.path,depth=EXCLUDED.depth,
    author=EXCLUDED.author,created=EXCLUDED.created,text=EXCLUDED.text,deleted=EXCLUDED.deleted,dead=EXCLUDED.dead,committed_at=EXCLUDED.committed_at
    WHERE (hn_comments.parent_id,hn_comments.path,hn_comments.depth,hn_comments.author,hn_comments.created,hn_comments.text,hn_comments.deleted,hn_comments.dead)
    IS DISTINCT FROM (EXCLUDED.parent_id,EXCLUDED.path,EXCLUDED.depth,EXCLUDED.author,EXCLUDED.created,EXCLUDED.text,EXCLUDED.deleted,EXCLUDED.dead)`
    }`,
    [JSON.stringify(records)],
  );
  const changed = (removed.rowCount ?? 0) + (written.rowCount ?? 0);
  await client.query(
    `UPDATE hn_threads SET state=$4,checked_at=CASE WHEN $4='healthy' THEN clock_timestamp() ELSE checked_at END,truncated=$2,
    loaded_at=CASE WHEN $5 THEN COALESCE(loaded_at,clock_timestamp()) ELSE loaded_at END,
    ingest_initialized=ingest_initialized OR $6,
    committed_at=CASE WHEN $3>0 THEN clock_timestamp() ELSE committed_at END WHERE story_id=$1`,
    [
      thread.story.id,
      thread.truncated,
      changed,
      complete ? "healthy" : "starting",
      complete || ids.length > 0,
      complete,
    ],
  );
  return changed;
}
