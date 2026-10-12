import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { migrate } from "../ingest/migrate";
import { loadThread } from "../ingest/thread-load";
import { updateThreadView, watchedThreads } from "../ingest/thread-watch";
import { publishThread } from "../ingest/thread-store";
import type { ThreadSnapshot } from "../ingest/comment-tree";

test(
  "cold page seeds, concurrent requests, partial publications and ownership races",
  { skip: !process.env.RUN_DB_TESTS },
  async () => {
    const schema = `hn_loading_test_${Date.now()}`;
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
      await pool.query(
        "INSERT INTO hn_items(id,type,title,created,committed_at) SELECT id,'story','Test story',0,'initial' FROM generate_series(1,5) id",
      );
      let reads = 0;
      const reader = async (path: string) => {
        reads++;
        await delay(80);
        const id = Number(path.slice(5));
        return id === 1
          ? { id, type: "story", kids: [11] }
          : { id, type: "comment", text: "Seed", kids: [12] };
      };
      await Promise.all([
        loadThread(pool, 1, reader),
        loadThread(pool, 1, reader),
        loadThread(pool, 1, reader),
      ]);
      assert.equal(
        reads,
        2,
        "one root and one initial comment, shared across requests",
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_comments WHERE story_id=1"))
          .rows[0].count,
        "1",
      );
      await loadThread(pool, 1, reader);
      assert.equal(reads, 2, "cached load does not fetch HN");
      assert.deepEqual(
        await watchedThreads(pool),
        [],
        "prefetch/SSR loading does not create ongoing watches",
      );
      const complete: ThreadSnapshot = {
        story: { id: 1 },
        receivedAt: Date.now(),
        truncated: false,
        rows: [
          {
            item: { id: 11, text: "Newer value" },
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
      const publish = async (snapshot: ThreadSnapshot) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const count = await publishThread(
            client,
            snapshot,
            new Date().toISOString(),
          );
          await client.query("COMMIT");
          return count;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      };
      await publish(complete);
      assert.equal(
        await publish({
          ...complete,
          complete: false,
          rows: [{ ...complete.rows[0], item: { id: 11, text: "Stale seed" } }],
        }),
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT text FROM hn_comments WHERE story_id=1 ORDER BY path",
          )
        ).rows[0].text,
        "Newer value",
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM hn_comments WHERE story_id=1"))
          .rows[0].count,
        "2",
      );
      assert.equal(
        await publish({ ...complete, rows: [complete.rows[0]] }),
        1,
        "authoritative snapshots remove missing descendants",
      );

      let fetched!: () => void;
      let finish!: () => void;
      const started = new Promise<void>((resolve) => {
        fetched = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const loading = loadThread(pool, 2, async () => {
        fetched();
        await gate;
        return { id: 2, type: "story", kids: [] };
      });
      await started;
      await publish({
        story: { id: 2 },
        rows: [
          {
            item: { id: 21, text: "Worker wins" },
            parentId: 2,
            path: "000001",
            depth: 0,
          },
        ],
        receivedAt: Date.now(),
        truncated: false,
      });
      finish();
      await loading;
      assert.equal(
        (await pool.query("SELECT text FROM hn_comments WHERE story_id=2"))
          .rows[0].text,
        "Worker wins",
      );

      const replacement = randomUUID();
      await loadThread(pool, 3, async () => {
        await pool.query(
          "UPDATE hn_threads SET initial_load_owner=$2 WHERE story_id=$1",
          [3, replacement],
        );
        return { id: 3, type: "story", kids: [] };
      });
      const replaced = (
        await pool.query(
          "SELECT initial_load_owner,loaded_at FROM hn_threads WHERE story_id=3",
        )
      ).rows[0];
      assert.equal(replaced.initial_load_owner, replacement);
      assert.equal(
        replaced.loaded_at,
        null,
        "an expired/replaced owner cannot seed or release another owner's claim",
      );
      await pool.query(
        "UPDATE hn_threads SET initial_load_until=clock_timestamp()-interval '1 second' WHERE story_id=3",
      );
      await loadThread(pool, 3, async () => ({ id: 3, type: "story" }));
      assert.ok(
        (await pool.query("SELECT loaded_at FROM hn_threads WHERE story_id=3"))
          .rows[0].loaded_at,
      );
      await assert.rejects(
        loadThread(pool, 4, async () => {
          throw new Error("HN offline");
        }),
        /offline/,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT initial_load_owner FROM hn_threads WHERE story_id=4",
          )
        ).rows[0].initial_load_owner,
        null,
      );
      await loadThread(pool, 999, async () => {
        throw new Error("Unknown story should not fetch");
      });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  "more than three open threads, independent viewers, expiry and reordered release",
  { skip: !process.env.RUN_DB_TESTS },
  async () => {
    const schema = `hn_views_test_${Date.now()}`;
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
      await pool.query(
        "INSERT INTO hn_items(id,type,title,created,committed_at) SELECT id,'story','Test',0,'initial' FROM generate_series(1,5) id",
      );
      const viewers = Array.from({ length: 5 }, () => randomUUID());
      const health = await Promise.all(
        viewers.map((viewer, i) => updateThreadView(pool, i + 1, viewer)),
      );
      assert.ok(health.every((value) => value?.state === "starting"));
      assert.deepEqual(await watchedThreads(pool), [1, 2, 3, 4, 5]);
      const another = randomUUID();
      await updateThreadView(pool, 1, another);
      await updateThreadView(pool, 1, viewers[0], true);
      assert.deepEqual(
        await watchedThreads(pool),
        [1, 2, 3, 4, 5],
        "another viewer keeps the same story watched",
      );
      await updateThreadView(pool, 1, another, true);
      await updateThreadView(pool, 1, viewers[0]);
      assert.deepEqual(
        await watchedThreads(pool),
        [2, 3, 4, 5],
        "late renewal cannot resurrect a released watch",
      );
      const arrivedLate = randomUUID();
      await updateThreadView(pool, 1, arrivedLate, true);
      await updateThreadView(pool, 1, arrivedLate);
      assert.deepEqual(await watchedThreads(pool), [2, 3, 4, 5]);
      await pool.query(
        "UPDATE hn_thread_views SET requested_at=clock_timestamp()-interval '31 seconds' WHERE story_id=2",
      );
      assert.deepEqual(await watchedThreads(pool), [3, 4, 5]);
      await updateThreadView(pool, 2);
      assert.deepEqual(
        await watchedThreads(pool),
        [2, 3, 4, 5],
        "old clients still renew a short legacy lease",
      );
      assert.equal(await updateThreadView(pool, 999, randomUUID()), null);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
