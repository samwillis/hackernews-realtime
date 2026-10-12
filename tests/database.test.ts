import { migrate } from "../ingest/migrate";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { Leases, LostLease } from "../ingest/lease";
import { publish } from "../ingest/store";
import type { ThreadSnapshot } from "../ingest/threads";
test(
  "database fencing, atomic membership and conditional updates",
  { skip: !process.env.RUN_DB_TESTS },
  async () => {
    const schema = `hn_test_${Date.now()}`;
    const admin = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    try {
      await migrate(pool);
      const a = new Leases(pool, "a", Date.now() + 120000, 60000, 30000);
      const b = new Leases(pool, "b", Date.now() + 120000, 60000, 30000);
      const [first, second] = await Promise.all([a.acquire(), b.acquire()]);
      assert.equal(
        [first, second].filter((result) => result.role === "active").length,
        1,
      );
      const winner = first.role === "active" ? a : b;
      const winnerToken =
        first.role === "active" ? first.fencing : second.fencing;
      const loser = winner === a ? b : a;
      const snapshot = {
        feeds: { top: [1, 2], new: [2, 1] },
        items: new Map([
          [1, { id: 1, title: "One", score: 1 }],
          [2, { id: 2, title: "Two", score: 2 }],
        ]),
        revision: 1,
        receivedAt: Date.now(),
        reconciledAt: Date.now(),
      };
      assert.equal(await publish(pool, winner, winnerToken, snapshot), 6);
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_events")).rows[0].count,
        "6",
      );
      assert.equal(await publish(pool, winner, winnerToken, snapshot), 0);
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_events")).rows[0].count,
        "6",
      );
      await assert.rejects(
        publish(pool, loser, winnerToken, snapshot),
        LostLease,
      );
      const broken = { ...snapshot, feeds: { top: [3], new: [] } };
      await assert.rejects(
        publish(pool, winner, winnerToken, broken),
        /incomplete/,
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_feed_entries")).rows[0]
          .count,
        "4",
      );
      await pool.query("INSERT INTO hn_threads(story_id) VALUES(1)");
      const thread: ThreadSnapshot = {
        story: snapshot.items.get(1)!,
        truncated: false,
        receivedAt: Date.now(),
        rows: [
          {
            item: {
              id: 11,
              type: "comment",
              text: "hello",
              by: "alice",
              time: 123,
            },
            parentId: 1,
            path: "000001",
            depth: 0,
          },
          {
            item: { id: 12, type: "comment", text: "reply" },
            parentId: 11,
            path: "000001.000001",
            depth: 1,
          },
        ],
      };
      assert.equal(
        await publish(pool, winner, winnerToken, {
          ...snapshot,
          threads: [thread],
        }),
        2,
      );
      assert.equal(
        await publish(pool, winner, winnerToken, {
          ...snapshot,
          threads: [thread],
        }),
        0,
      );
      const edited = {
        ...thread,
        rows: [
          {
            ...thread.rows[0],
            item: { ...thread.rows[0].item, text: "edited" },
          },
        ],
      };
      assert.equal(
        await publish(pool, winner, winnerToken, {
          ...snapshot,
          threads: [edited],
        }),
        2,
      );
      assert.equal(
        (await pool.query("SELECT text FROM hn_comments WHERE story_id=1"))
          .rows[0].text,
        "edited",
      );
      const invalid = {
        ...thread,
        rows: [{ ...thread.rows[0], parentId: 99 }],
      };
      const eventsBeforeRollback = (
        await pool.query("SELECT count(*) FROM hn_events")
      ).rows[0].count;
      await assert.rejects(
        publish(pool, winner, winnerToken, {
          ...snapshot,
          feeds: { top: [2, 1], new: [1] },
          threads: [invalid],
        }),
        /Invalid thread snapshot/,
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_events")).rows[0].count,
        eventsBeforeRollback,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT item_id FROM hn_feed_entries WHERE feed='top' ORDER BY rank",
          )
        ).rows.map((row) => row.item_id),
        [1, 2],
      );
      assert.equal(
        (await pool.query("SELECT text FROM hn_comments WHERE story_id=1"))
          .rows[0].text,
        "edited",
      );
      const deleted = {
        ...edited,
        rows: [
          {
            ...edited.rows[0],
            item: { ...edited.rows[0].item, text: "", deleted: true },
          },
        ],
      };
      assert.equal(
        await publish(pool, winner, winnerToken, {
          ...snapshot,
          threads: [deleted],
        }),
        1,
      );
      await assert.rejects(
        publish(pool, loser, winnerToken, { ...snapshot, threads: [thread] }),
        LostLease,
      );
      assert.equal(
        (await pool.query("SELECT deleted FROM hn_comments WHERE story_id=1"))
          .rows[0].deleted,
        true,
      );
      await pool.query(
        "UPDATE ingest_leases SET active_session_end=clock_timestamp()+interval '10 seconds'",
      );
      const standby = await loser.acquire();
      assert.equal(standby.role, "standby");
      await loser.renew("standby", standby.fencing, true);
      assert.equal(await winner.handoff(winnerToken), loser.owner);
      const promoted = await loser.promoteIfNeeded();
      assert.ok(promoted);
      assert.notEqual(promoted.fencing, winnerToken);
      await assert.rejects(
        publish(pool, winner, winnerToken, snapshot),
        LostLease,
      );
      await publish(pool, loser, promoted.fencing, {
        ...snapshot,
        feeds: { top: [2, 1], new: [2] },
      });
      assert.deepEqual(
        (
          await pool.query(
            "SELECT item_id FROM hn_feed_entries WHERE feed='top' ORDER BY rank,item_id",
          )
        ).rows.map((row) => row.item_id),
        [2, 1],
      );
      const lease = (
        await pool.query(
          "SELECT active_session_end,active_deadline FROM ingest_leases",
        )
      ).rows[0];
      assert.ok(+lease.active_session_end <= +lease.active_deadline - 10000);
      await pool.query(
        "UPDATE ingest_leases SET active_until=clock_timestamp()-interval '1 second'",
      );
      const replacement = await winner.acquire();
      assert.equal(replacement.role, "active");
      await assert.rejects(
        publish(pool, loser, promoted.fencing, snapshot),
        LostLease,
      );
      await publish(pool, winner, replacement.fencing, snapshot);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  "event journal covers all mirrored fields, movement, removals and retention",
  { skip: !process.env.RUN_DB_TESTS },
  async () => {
    const schema = `hn_events_test_${Date.now()}`;
    const admin = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
      options: `-c search_path=${schema}`,
      max: 1,
    });
    try {
      await migrate(pool);
      await pool.query(
        "INSERT INTO hn_items(id,type,title,created,committed_at) VALUES(99,'story','Off-page story',0,'initial')",
      );
      await pool.query(
        "INSERT INTO hn_feed_entries(feed,item_id,rank) VALUES('top',99,75)",
      );
      await pool.query(
        "UPDATE hn_items SET score=5,comments=2,title='Edited title',dead=true WHERE id=99",
      );
      const update = (
        await pool.query("SELECT * FROM hn_events WHERE kind='story-updated'")
      ).rows[0];
      assert.equal(update.item_id, 99);
      assert.deepEqual(Object.keys(JSON.parse(update.details)).sort(), [
        "comments",
        "dead",
        "score",
        "title",
      ]);
      await pool.query(
        "UPDATE hn_items SET committed_at='no domain change' WHERE id=99",
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_events")).rows[0].count,
        "3",
      );
      await pool.query("UPDATE hn_feed_entries SET rank=1 WHERE item_id=99");
      await pool.query("DELETE FROM hn_feed_entries WHERE item_id=99");
      await pool.query(
        "INSERT INTO hn_comments(story_id,item_id,parent_id,path,depth,created,text,deleted,dead,committed_at) VALUES(99,100,99,'000001',0,0,'hello',false,false,'initial')",
      );
      await pool.query(
        "UPDATE hn_comments SET text='edited',path='000002',deleted=true WHERE item_id=100",
      );
      await pool.query("DELETE FROM hn_comments WHERE item_id=100");
      const kinds = (
        await pool.query("SELECT kind FROM hn_events ORDER BY id")
      ).rows.map((row) => row.kind);
      assert.deepEqual(kinds, [
        "story-added",
        "top-entered",
        "story-updated",
        "top-moved",
        "top-left",
        "comment-added",
        "comment-updated",
        "comment-removed",
      ]);
      await pool.query("UPDATE hn_events SET occurred_at=0 WHERE id=1");
      await pool.query("UPDATE hn_items SET score=score WHERE id=99");
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_events")).rows[0].count,
        "7",
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
