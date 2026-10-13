import type { Pool, PoolClient } from "pg";
import type { Feed } from "../lib/types";
import { Leases } from "./lease";
import type { SourceSnapshot, HnItem } from "./source";
import { publishThread } from "./thread-store";
export function itemRecord(item: HnItem, committedAt: string) {
  return {
    id: item.id,
    type: item.type ?? "story",
    title: item.title ?? "",
    url: item.url ?? null,
    author: item.by ?? null,
    created: item.time ?? 0,
    score: item.score ?? 0,
    comments: item.descendants ?? 0,
    deleted: Boolean(item.deleted || !item.title),
    dead: Boolean(item.dead),
    committed_at: committedAt,
    body: item.text ?? null,
  };
}
export type ItemRecord = ReturnType<typeof itemRecord>;

export async function writeItems(
  client: PoolClient,
  records: ItemRecord[],
  insertOnly = false,
) {
  const { rows } = await client.query(
    `INSERT INTO hn_items(id,type,title,url,author,created,score,comments,deleted,dead,committed_at,body) SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS x(id integer,type text,title text,url text,author text,created integer,score integer,comments integer,deleted boolean,dead boolean,committed_at text,body text)
    ON CONFLICT(id) ${
      insertOnly
        ? "DO NOTHING"
        : `DO UPDATE SET type=EXCLUDED.type,title=EXCLUDED.title,url=EXCLUDED.url,author=EXCLUDED.author,
    created=EXCLUDED.created,score=EXCLUDED.score,comments=EXCLUDED.comments,deleted=EXCLUDED.deleted,dead=EXCLUDED.dead,committed_at=EXCLUDED.committed_at,body=EXCLUDED.body
    WHERE (hn_items.type,hn_items.title,hn_items.url,hn_items.author,hn_items.created,hn_items.score,hn_items.comments,hn_items.deleted,hn_items.dead,hn_items.body)
    IS DISTINCT FROM (EXCLUDED.type,EXCLUDED.title,EXCLUDED.url,EXCLUDED.author,EXCLUDED.created,EXCLUDED.score,EXCLUDED.comments,EXCLUDED.deleted,EXCLUDED.dead,EXCLUDED.body)`
    } RETURNING id`,
    [JSON.stringify(records)],
  );
  return rows.map((row): number => row.id);
}

export async function writeFeed(client: PoolClient, feed: Feed, ids: number[]) {
  const removed = await client.query(
    "DELETE FROM hn_feed_entries WHERE feed=$1 AND NOT(item_id=ANY($2::integer[]))",
    [feed, ids],
  );
  const ranked = await client.query(
    `INSERT INTO hn_feed_entries(feed,item_id,rank) SELECT $1,id,ordinality FROM unnest($2::integer[]) WITH ORDINALITY AS x(id,ordinality)
    ON CONFLICT(feed,item_id) DO UPDATE SET rank=EXCLUDED.rank WHERE hn_feed_entries.rank IS DISTINCT FROM EXCLUDED.rank`,
    [feed, ids],
  );
  return (removed.rowCount ?? 0) + (ranked.rowCount ?? 0);
}

export async function recordCommit(
  client: PoolClient,
  leases: Leases,
  counts: {
    changedItems: number;
    changedEntries: number;
    changedComments: number;
  },
  received: number[],
  revision: number,
  committedAt: string,
  smoothingMs = 0,
) {
  const changed =
    counts.changedItems + counts.changedEntries + counts.changedComments;
  if (!changed) return 0;
  const oldestReceived = Math.min(...received.filter(Boolean));
  await client.query(
    `UPDATE ingest_status SET committed_at=clock_timestamp(), source_event_at=$1, owner=$2, writes=writes+$3 WHERE id=1`,
    [new Date(Math.max(...received.filter(Boolean))), leases.owner, changed],
  );
  await client.query(
    `INSERT INTO ingest_events(owner,kind,details) VALUES($1,'commit',$2::jsonb)`,
    [
      leases.owner,
      JSON.stringify({
        ...counts,
        receivedAt: oldestReceived,
        commitAt: committedAt,
        latencyMs: Date.now() - oldestReceived,
        revision,
        smoothingMs,
      }),
    ],
  );
  return changed;
}
export async function publish(
  pool: Pool,
  leases: Leases,
  fencing: string,
  snapshot: SourceSnapshot,
) {
  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query("BEGIN");
    await leases.assert(client, fencing);
    const committedAt = new Date().toISOString();
    const ids = new Set([...snapshot.feeds.top, ...snapshot.feeds.new]);
    if ([...ids].some((id) => !snapshot.items.has(id)))
      throw new Error("Feed snapshot is incomplete");
    const sourceItems = new Map(
      [...ids].map((id) => [id, snapshot.items.get(id)!]),
    );
    for (const thread of snapshot.threads ?? [])
      sourceItems.set(thread.story.id, thread.story);
    const records = [...sourceItems.values()].map((item) =>
      itemRecord(item, committedAt),
    );
    const updatedItems = await writeItems(client, records);
    const changedItems = updatedItems.length;
    let changedEntries = 0;
    const received = updatedItems.map(
      (id) =>
        (snapshot.threads ?? []).find((thread) => thread.story.id === id)
          ?.receivedAt ??
        snapshot.itemReceipts?.get(id) ??
        snapshot.receivedAt,
    );
    for (const feed of ["top", "new"] as const) {
      const changed = await writeFeed(client, feed, snapshot.feeds[feed]);
      changedEntries += changed;
      if (changed)
        received.push(snapshot.feedReceipts?.[feed] || snapshot.receivedAt);
    }
    let changedComments = 0;
    for (const thread of snapshot.threads ?? []) {
      const changed = await publishThread(client, thread, committedAt);
      changedComments += changed;
      if (changed) received.push(thread.receivedAt);
    }
    // Recheck expiry immediately before commit; the row lock fences a concurrent takeover.
    await leases.assert(client, fencing);
    const changed = await recordCommit(
      client,
      leases,
      { changedItems, changedEntries, changedComments },
      received.length ? received : [snapshot.receivedAt || started],
      snapshot.revision,
      committedAt,
    );
    await client.query("COMMIT");
    return changed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
