import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { migrate } from "../ingest/migrate";
import { Leases, LostLease } from "../ingest/lease";
import { SmoothingPublisher } from "../ingest/smoothing";
import type { SourceSnapshot } from "../ingest/source";
import type { ThreadSnapshot } from "../ingest/comment-tree";

test(
  "durable smoothing preserves deadlines, atomic trees/ranks, handoffs and immediate mode",
  { skip: !process.env.RUN_DB_TESTS, timeout: 60000 },
  async () => {
    const schema = `hn_smoothing_${Date.now()}`;
    const admin = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
    });
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewing: Promise<unknown> | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      const first = new Leases(
        pool,
        "first",
        Date.now() + 120000,
        90000,
        60000,
      );
      const token = (await first.acquire()).fencing;
      let keeper = { lease: first, token };
      heartbeat = setInterval(() => {
        if (!renewing)
          renewing = keeper.lease
            .renew("active", keeper.token, true)
            .finally(() => {
              renewing = undefined;
            });
      }, 5000);
      const publisher = new SmoothingPublisher(pool, first, 28000);
      const snapshot: SourceSnapshot = {
        feeds: { top: [1, 2, 3, 4, 5, 6], new: [6, 5, 4, 3, 2, 1] },
        items: new Map(
          [1, 2, 3, 4, 5, 6].map((id) => [
            id,
            { id, title: `Story ${id}`, score: 0 },
          ]),
        ),
        revision: 1,
        receivedAt: Date.now(),
        reconciledAt: Date.now(),
      };
      assert.equal(
        await publisher.tick(token, snapshot),
        18,
        "Empty feed fills immediately",
      );
      const burst: SourceSnapshot = {
        ...snapshot,
        revision: 2,
        receivedAt: Date.now(),
        feeds: { ...snapshot.feeds, top: [7, 1, 2, 3, 4, 5] },
        items: new Map(
          [1, 2, 3, 4, 5, 6, 7].map((id) => [
            id,
            { id, title: `Story ${id}`, score: 1 },
          ]),
        ),
      };
      assert.equal(await publisher.tick(token, burst), 0);
      // Keep fixture deadlines in the future while database round trips run;
      // individual releases below are controlled without wall-clock races.
      await pool.query("UPDATE hn_ingest_pending SET due_at=due_at+120000");
      const queued = (
        await pool.query(
          "SELECT key,due_at FROM hn_ingest_pending ORDER BY key",
        )
      ).rows;
      assert.equal(queued.length, 8);
      assert.equal(
        new Set(queued.map((job) => job.due_at)).size,
        8,
        "Separate operations have separate deadlines",
      );
      assert.equal(await publisher.tick(token, { ...burst, revision: 3 }), 0);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT key,due_at FROM hn_ingest_pending ORDER BY key",
          )
        ).rows,
        queued,
        "Unchanged source values do not restart the delay",
      );
      const newest: SourceSnapshot = {
        ...burst,
        revision: 4,
        items: new Map(burst.items),
      };
      newest.items.set(1, { ...newest.items.get(1)!, score: 2 });
      newest.items.set(2, { ...newest.items.get(2)!, score: 0 });
      await publisher.tick(token, newest);
      assert.equal(
        (
          await pool.query(
            "SELECT due_at FROM hn_ingest_pending WHERE key='item:1'",
          )
        ).rows[0].due_at,
        queued.find((job) => job.key === "item:1").due_at,
        "Latest value retains its first deadline",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT key FROM hn_ingest_pending WHERE key='item:2'",
          )
        ).rowCount,
        0,
        "A reverted change is cancelled",
      );
      await pool.query(
        "UPDATE hn_ingest_pending SET due_at=0 WHERE key='feed:top'",
      );
      publisher.reset();
      await publisher.tick(token);
      const feed = (
        await pool.query(
          "SELECT item_id,rank FROM hn_feed_entries WHERE feed='top' ORDER BY rank",
        )
      ).rows;
      assert.deepEqual(
        feed.map((row) => row.item_id),
        newest.feeds.top,
      );
      assert.deepEqual(
        feed.map((row) => row.rank),
        [1, 2, 3, 4, 5, 6],
      );
      assert.equal(
        (await pool.query("SELECT title FROM hn_items WHERE id=7")).rows[0]
          .title,
        "Story 7",
      );
      assert.equal(
        (await pool.query("SELECT score FROM hn_items WHERE id=1")).rows[0]
          .score,
        0,
        "Feed reorders do not bypass unrelated score delays",
      );
      await publisher.tick(token, newest);

      // Transfer ownership with pending future work. The successor sees exactly
      // the same deadlines and the old writer cannot stage or apply anything.
      await pool.query(
        "UPDATE ingest_leases SET active_session_end=clock_timestamp()",
      );
      const second = new Leases(
        pool,
        "second",
        Date.now() + 120000,
        90000,
        60000,
      );
      assert.equal((await second.acquire()).role, "standby");
      await second.renew("standby", token, true);
      assert.equal(await first.handoff(token), "second");
      const nextToken = (await second.promoteIfNeeded())!.fencing;
      keeper = { lease: second, token: nextToken };
      const successor = new SmoothingPublisher(pool, second, 28000);
      const before = (
        await pool.query(
          "SELECT key,due_at FROM hn_ingest_pending ORDER BY key",
        )
      ).rows;
      assert.equal(await successor.tick(nextToken, newest), 0);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT key,due_at FROM hn_ingest_pending ORDER BY key",
          )
        ).rows,
        before,
      );
      await assert.rejects(publisher.tick(token, newest), LostLease);
      await pool.query("UPDATE hn_ingest_pending SET due_at=0");
      successor.reset();
      await successor.tick(nextToken);
      assert.deepEqual(
        (await pool.query("SELECT score FROM hn_items ORDER BY id")).rows.map(
          (row) => row.score,
        ),
        [2, 0, 1, 1, 1, 1, 1],
      );

      await pool.query("INSERT INTO hn_threads(story_id) VALUES(1)");
      const thread: ThreadSnapshot = {
        story: { ...newest.items.get(1)!, descendants: 2 },
        receivedAt: Date.now(),
        truncated: false,
        rows: [
          {
            item: { id: 11, text: "Parent" },
            parentId: 1,
            path: "000001",
            depth: 0,
          },
          {
            item: { id: 12, text: "Reply" },
            parentId: 11,
            path: "000001.000001",
            depth: 1,
          },
        ],
      };
      await successor.tick(nextToken, {
        ...newest,
        threads: [thread],
        revision: 5,
      });
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_comments")).rows[0].count,
        "2",
        "A new thread fills immediately",
      );
      const changed: ThreadSnapshot = {
        ...thread,
        story: { ...thread.story, descendants: 3 },
        rows: [
          { ...thread.rows[0], item: { id: 11, text: "Edited parent" } },
          { ...thread.rows[1], item: { id: 12, text: "Edited reply" } },
          {
            item: { id: 13, text: "New reply" },
            parentId: 11,
            path: "000001.000002",
            depth: 1,
          },
        ],
      };
      assert.equal(
        await successor.tick(nextToken, {
          ...newest,
          threads: [changed],
          revision: 6,
        }),
        0,
      );
      await pool.query("UPDATE hn_ingest_pending SET due_at=due_at+120000");
      await pool.query(
        "UPDATE hn_ingest_pending SET due_at=0 WHERE key='comment:1:11'",
      );
      successor.reset();
      await successor.tick(nextToken);
      assert.equal(
        (await pool.query("SELECT text FROM hn_comments WHERE item_id=11"))
          .rows[0].text,
        "Edited parent",
      );
      const again = {
        ...changed,
        rows: changed.rows.map((row) =>
          row.item.id === 13
            ? { ...row, item: { ...row.item, text: "Edited new reply" } }
            : row,
        ),
      };
      await successor.tick(nextToken, {
        ...newest,
        threads: [again],
        revision: 7,
      });
      const dependencies = (
        await pool.query(
          "SELECT key,due_at FROM hn_ingest_pending WHERE key IN ('thread:1','comment:1:13')",
        )
      ).rows;
      assert.equal(dependencies.length, 2);
      assert.ok(
        Number(dependencies.find((job) => job.key === "comment:1:13").due_at) >=
          Number(dependencies.find((job) => job.key === "thread:1").due_at),
      );
      await pool.query(
        "UPDATE hn_ingest_pending SET due_at=0 WHERE key='thread:1'",
      );
      successor.reset();
      await successor.tick(nextToken);
      assert.equal(
        (await pool.query("SELECT text FROM hn_comments WHERE item_id=11"))
          .rows[0].text,
        "Edited parent",
        "Later tree writes preserve already published comment edits",
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_comments")).rows[0].count,
        "3",
      );

      // Remove a reply while its edit is pending; content jobs never insert it.
      const removed = {
        ...again,
        story: { ...again.story, descendants: 2 },
        rows: again.rows.slice(0, 2),
      };
      await successor.tick(nextToken, {
        ...newest,
        threads: [removed],
        revision: 8,
      });
      await pool.query(
        "UPDATE hn_ingest_pending SET due_at=0 WHERE key='thread:1'",
      );
      successor.reset();
      await successor.tick(nextToken);
      assert.equal(
        (await pool.query("SELECT item_id FROM hn_comments WHERE item_id=13"))
          .rowCount,
        0,
      );
      const immediate = new SmoothingPublisher(pool, second, 0);
      await immediate.tick(nextToken, {
        ...newest,
        threads: [removed],
        revision: 9,
      });
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_ingest_pending")).rows[0]
          .count,
        "0",
      );
      assert.equal(
        (await pool.query("SELECT item_id FROM hn_comments WHERE item_id=13"))
          .rowCount,
        0,
      );
      assert.equal(
        (await pool.query("SELECT text FROM hn_comments WHERE item_id=12"))
          .rows[0].text,
        "Edited reply",
      );
      const final = { ...newest, revision: 10, items: new Map(newest.items) };
      final.items.set(2, { ...final.items.get(2)!, score: 5 });
      await immediate.tick(nextToken, final);
      assert.equal(
        (await pool.query("SELECT score FROM hn_items WHERE id=2")).rows[0]
          .score,
        5,
      );

      const events = (await pool.query("SELECT count(*) FROM hn_events"))
        .rows[0].count;
      await assert.rejects(
        successor.tick(nextToken, {
          ...final,
          threads: [
            { ...removed, rows: [{ ...removed.rows[0], parentId: 99 }] },
          ],
        }),
        /Invalid thread/,
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_events")).rows[0].count,
        events,
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_ingest_pending")).rows[0]
          .count,
        "0",
      );
    } finally {
      clearInterval(heartbeat);
      await renewing;
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
