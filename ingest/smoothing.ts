import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import type { Feed } from "../lib/types";
import type { SourceSnapshot } from "./source";
import type { ThreadSnapshot } from "./comment-tree";
import { Leases } from "./lease";
import {
  itemRecord,
  writeItems,
  writeFeed,
  recordCommit,
  type ItemRecord,
} from "./store";
import {
  commentRecords,
  publishThread,
  publishComment,
  validateThread,
  type CommentRecord,
} from "./thread-store";

export type Change =
  | { kind: "item"; record: ItemRecord }
  | { kind: "feed"; feed: Feed; ids: number[]; items: ItemRecord[] }
  | { kind: "thread"; thread: ThreadSnapshot }
  | { kind: "comment"; record: CommentRecord; afterStructure?: boolean };
export interface PendingChange {
  key: string;
  due_at: number;
  received_at: number;
  revision: number;
  payload: Change;
}

const content = (row: CommentRecord) => [
  row.author,
  row.created,
  row.text,
  row.deleted,
  row.dead,
];
const structure = (rows: CommentRecord[], truncated: boolean) => ({
  rows: rows.map((row) => [row.item_id, row.parent_id, row.path, row.depth]),
  truncated,
});
const sameItem = (a: ItemRecord | undefined, b: ItemRecord) =>
  a &&
  Object.keys(b).every(
    (key) =>
      key === "committed_at" ||
      a[key as keyof ItemRecord] === b[key as keyof ItemRecord],
  );

// Existing deadlines survive revisions and handoffs. Overlapping updates to a
// row replace its pending value rather than postponing it indefinitely.
export function spreadChanges(
  changes: PendingChange[],
  now: number,
  windowMs: number,
) {
  const fresh = changes
    .filter((change) => change.due_at < 0)
    .sort((a, b) => a.key.localeCompare(b.key));
  fresh.forEach((change, index) => {
    change.due_at = Math.round(
      now + (windowMs * (index + 1)) / (fresh.length + 1),
    );
  });
  const structures = new Map(
    changes
      .filter((change) => change.payload.kind === "thread")
      .map((change) => [change.key, change.due_at]),
  );
  for (const change of changes)
    if (change.payload.kind === "comment" && change.payload.afterStructure) {
      const due = structures.get(`thread:${change.payload.record.story_id}`);
      if (due !== undefined) change.due_at = Math.max(change.due_at, due);
    }
  return changes;
}

export class SmoothingPublisher {
  private nextDueAt = 0;
  constructor(
    private pool: Pool,
    private leases: Leases,
    readonly windowMs: number,
  ) {
    if (!Number.isInteger(windowMs) || windowMs < 0 || windowMs > 60000)
      throw new Error("Invalid ingestion smoothing window (0–60000 ms)");
  }
  reset() {
    this.nextDueAt = 0;
  }

  async tick(fencing: string, snapshot?: SourceSnapshot) {
    if (!snapshot && Date.now() < this.nextDueAt) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.leases.assert(client, fencing);
      const clockReadAt = Date.now();
      const now = Number(
        (
          await client.query(
            "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
          )
        ).rows[0].now,
      );
      const committedAt = new Date(now).toISOString();
      const counts = { changedItems: 0, changedEntries: 0, changedComments: 0 };
      const received: number[] = [];
      if (snapshot)
        await this.stage(client, snapshot, now, committedAt, counts, received);
      const due: PendingChange[] = (
        await client.query(
          `SELECT * FROM hn_ingest_pending WHERE due_at<=$1 OR $2=0 ORDER BY
         CASE payload->>'kind' WHEN 'item' THEN 0 WHEN 'feed' THEN 1 WHEN 'thread' THEN 2 ELSE 3 END,
         due_at,key`,
          [now, this.windowMs],
        )
      ).rows;
      for (const job of due) {
        const change = job.payload;
        if (change.kind === "item")
          counts.changedItems += (
            await writeItems(client, [
              { ...change.record, committed_at: committedAt },
            ])
          ).length;
        else if (change.kind === "feed") {
          // New feed entries need complete records; existing items retain their
          // independently scheduled score/count updates.
          counts.changedItems += (
            await writeItems(
              client,
              change.items.map((record) => ({
                ...record,
                committed_at: committedAt,
              })),
              true,
            )
          ).length;
          counts.changedEntries += await writeFeed(
            client,
            change.feed,
            change.ids,
          );
        } else if (change.kind === "thread")
          counts.changedComments += await publishThread(
            client,
            change.thread,
            committedAt,
            true,
          );
        else
          counts.changedComments += await publishComment(
            client,
            change.record,
            committedAt,
          );
        received.push(Number(job.received_at));
      }
      await client.query(
        "DELETE FROM hn_ingest_pending WHERE key=ANY($1::text[])",
        [due.map((job) => job.key)],
      );
      await this.leases.assert(client, fencing);
      const changed = await recordCommit(
        client,
        this.leases,
        counts,
        received,
        snapshot?.revision ?? Number(due.at(-1)?.revision ?? 0),
        committedAt,
        this.windowMs,
      );
      const next = (
        await client.query("SELECT min(due_at) AS due FROM hn_ingest_pending")
      ).rows[0].due;
      await client.query("COMMIT");
      this.nextDueAt =
        next === null ? Infinity : clockReadAt + Math.max(0, Number(next) - now);
      return changed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async stage(
    client: PoolClient,
    snapshot: SourceSnapshot,
    now: number,
    committedAt: string,
    counts: {
      changedItems: number;
      changedEntries: number;
      changedComments: number;
    },
    received: number[],
  ) {
    const feedIds = new Set([...snapshot.feeds.top, ...snapshot.feeds.new]);
    if ([...feedIds].some((id) => !snapshot.items.has(id)))
      throw new Error("Feed snapshot is incomplete");
    for (const thread of snapshot.threads ?? []) validateThread(thread);
    const sourceItems = new Map(
      [...feedIds].map((id) => [id, snapshot.items.get(id)!]),
    );
    for (const thread of snapshot.threads ?? [])
      sourceItems.set(thread.story.id, thread.story);
    const records = new Map(
      [...sourceItems].map(([id, item]) => [id, itemRecord(item, "")]),
    );
    const existingItems: Map<number, ItemRecord> = new Map(
      (
        await client.query(
          "SELECT * FROM hn_items WHERE id=ANY($1::integer[])",
          [[...records.keys()]],
        )
      ).rows.map((row) => [row.id, row]),
    );
    const feeds = (
      await client.query(
        "SELECT feed,item_id FROM hn_feed_entries ORDER BY feed,rank",
      )
    ).rows;
    const pending: Map<string, PendingChange> = new Map(
      (await client.query("SELECT * FROM hn_ingest_pending")).rows.map(
        (row) => [
          row.key,
          {
            ...row,
            due_at: Number(row.due_at),
            received_at: Number(row.received_at),
          },
        ],
      ),
    );
    const changes = new Map<string, PendingChange>();
    const cancelled = new Set<string>();
    const schedule = (
      key: string,
      payload: Change,
      matchesCurrent: boolean,
      matchesPending: boolean,
      receipt: number,
    ) => {
      const old = pending.get(key);
      if (matchesCurrent) {
        if (old) cancelled.add(key);
        return;
      }
      if (old && matchesPending) return;
      changes.set(key, {
        key,
        payload,
        due_at: old?.due_at ?? -1,
        received_at: (old?.received_at ?? receipt) || now,
        revision: snapshot.revision,
      });
    };

    // A fresh branch and a discussion's first reconciliation are baselines,
    // not bursts of live changes: fill them without an artificial wait.
    const bootstrap = feeds.length === 0;
    if (bootstrap) {
      counts.changedItems += (
        await writeItems(
          client,
          [...records.values()].map((row) => ({
            ...row,
            committed_at: committedAt,
          })),
        )
      ).length;
      for (const feed of ["top", "new"] as const)
        counts.changedEntries += await writeFeed(
          client,
          feed,
          snapshot.feeds[feed],
        );
      received.push(snapshot.receivedAt || now);
    }
    const storyIds = (snapshot.threads ?? []).map((thread) => thread.story.id);
    const threads = new Map(
      (
        await client.query(
          "SELECT story_id,ingest_initialized,truncated FROM hn_threads WHERE story_id=ANY($1::integer[]) FOR UPDATE",
          [storyIds],
        )
      ).rows.map((row) => [row.story_id, row]),
    );
    const comments: CommentRecord[] = (
      await client.query(
        "SELECT * FROM hn_comments WHERE story_id=ANY($1::integer[]) ORDER BY path,item_id",
        [storyIds],
      )
    ).rows;
    for (const thread of snapshot.threads ?? []) {
      const state = threads.get(thread.story.id);
      if (!state) throw new Error("Thread is not registered");
      if (!state.ingest_initialized) {
        const record = {
          ...records.get(thread.story.id)!,
          committed_at: committedAt,
        };
        counts.changedItems += (await writeItems(client, [record])).length;
        existingItems.set(record.id, record);
        cancelled.add(`item:${record.id}`);
        counts.changedComments += await publishThread(
          client,
          thread,
          committedAt,
        );
        received.push(thread.receivedAt || now);
        continue;
      }
      // A warming successor must not overwrite a complete queued tree with a
      // temporary partial snapshot. It will reconcile before changing it.
      if (thread.complete === false) continue;
      const key = `thread:${thread.story.id}`;
      const current = comments.filter(
        (row) => row.story_id === thread.story.id,
      );
      const next = commentRecords(thread, "");
      const old = pending.get(key)?.payload;
      const oldRows =
        old?.kind === "thread" ? commentRecords(old.thread, "") : [];
      const target = structure(next, thread.truncated);
      schedule(
        key,
        { kind: "thread", thread },
        isDeepStrictEqual(target, structure(current, state.truncated)),
        old?.kind === "thread" &&
          isDeepStrictEqual(target, structure(oldRows, old.thread.truncated)),
        thread.receivedAt,
      );
      for (const row of next) {
        const currentRow = current.find(
          (value) => value.item_id === row.item_id,
        );
        const planned = oldRows.find((value) => value.item_id === row.item_id);
        // New row contents are inserted with the structural update. If they
        // change again before insertion, schedule the edit after that update.
        if (!currentRow && !planned) continue;
        const commentKey = `comment:${row.story_id}:${row.item_id}`;
        const oldComment = pending.get(commentKey)?.payload;
        schedule(
          commentKey,
          { kind: "comment", record: row, afterStructure: !currentRow },
          isDeepStrictEqual(content(currentRow ?? planned!), content(row)),
          oldComment?.kind === "comment" &&
            isDeepStrictEqual(content(oldComment.record), content(row)),
          thread.receivedAt,
        );
      }
    }
    if (!bootstrap) {
      for (const [id, record] of records) {
        const key = `item:${id}`;
        const old = pending.get(key)?.payload;
        schedule(
          key,
          { kind: "item", record },
          Boolean(sameItem(existingItems.get(id), record)),
          Boolean(old?.kind === "item" && sameItem(old.record, record)),
          (snapshot.threads ?? []).find((thread) => thread.story.id === id)
            ?.receivedAt ??
            snapshot.itemReceipts?.get(id) ??
            snapshot.receivedAt,
        );
      }
      for (const feed of ["top", "new"] as const) {
        const key = `feed:${feed}`;
        const ids = snapshot.feeds[feed];
        const old = pending.get(key)?.payload;
        schedule(
          key,
          { kind: "feed", feed, ids, items: ids.map((id) => records.get(id)!) },
          isDeepStrictEqual(
            ids,
            feeds.filter((row) => row.feed === feed).map((row) => row.item_id),
          ),
          old?.kind === "feed" && isDeepStrictEqual(ids, old.ids),
          snapshot.feedReceipts?.[feed] || snapshot.receivedAt,
        );
      }
    }
    await client.query(
      "DELETE FROM hn_ingest_pending WHERE key=ANY($1::text[])",
      [[...cancelled]],
    );
    // Include existing structure deadlines when assigning dependent edits.
    const scheduled = spreadChanges(
      [
        ...changes.values(),
        ...[...pending.values()].filter(
          (job) =>
            job.payload.kind === "thread" &&
            !changes.has(job.key) &&
            !cancelled.has(job.key),
        ),
      ],
      now,
      this.windowMs,
    );
    await client.query(
      `INSERT INTO hn_ingest_pending(key,due_at,received_at,revision,payload)
       SELECT * FROM jsonb_to_recordset($1::jsonb)
       AS x(key text,due_at bigint,received_at bigint,revision bigint,payload jsonb)
       ON CONFLICT(key) DO UPDATE SET due_at=EXCLUDED.due_at,received_at=EXCLUDED.received_at,
       revision=EXCLUDED.revision,payload=EXCLUDED.payload`,
      [JSON.stringify(scheduled.filter((job) => changes.has(job.key)))],
    );
  }
}
