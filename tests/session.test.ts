import { migrate } from "../ingest/migrate";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { runSession } from "../ingest/session";
import { updateThreadView } from "../ingest/thread-watch";
import { randomUUID } from "node:crypto";

test("invalid time budgets fail before database acquisition", async () => {
  const pool = new Pool();
  try {
    for (const value of [NaN, Infinity, -1])
      await assert.rejects(runSession(pool, { budgetMs: value }), /Invalid/);
  } finally {
    await pool.end();
  }
});

test(
  "late standby receives a handoff within the original request deadline",
  { skip: !process.env.RUN_SOURCE_TESTS, timeout: 90000 },
  async () => {
    const schema = `hn_handoff_${Date.now()}`;
    const admin = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
    });
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED,
      options: `-c search_path=${schema}`,
      max: 6,
    });
    const stop = new AbortController();
    const sessions: Promise<unknown>[] = [];
    const waitFor = async (check: () => Promise<boolean>) => {
      const until = Date.now() + 60000;
      while (!(await check())) {
        if (Date.now() >= until) throw new Error("Handoff probe timed out");
        await delay(250);
      }
    };
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      const options = {
        budgetMs: 90000,
        tenureMs: 30000,
        overlapMs: 20000,
        signal: stop.signal,
      };
      const first = runSession(pool, { ...options, owner: "first" });
      sessions.push(first);
      // Deliberately withhold the standby until the active tenure has elapsed.
      await waitFor(
        async () =>
          (
            await pool.query(
              "SELECT 1 FROM ingest_events WHERE kind='handoff_waiting'",
            )
          ).rowCount === 1,
      );
      const waiting = (
        await pool.query(
          "SELECT active_owner,active_until>clock_timestamp() AS owned FROM ingest_leases",
        )
      ).rows[0];
      assert.equal(waiting.active_owner, "first");
      assert.equal(waiting.owned, true);
      const storyIds: number[] = (
        await pool.query(
          "SELECT id FROM hn_items WHERE comments BETWEEN 1 AND 100 AND NOT deleted AND NOT dead ORDER BY comments DESC LIMIT 4",
        )
      ).rows.map((row) => row.id);
      assert.equal(storyIds.length, 4, "Four live discussions are available");
      await Promise.all(
        storyIds.map((id) => updateThreadView(pool, id, randomUUID())),
      );
      const renewViews = setInterval(() => {
        void pool
          .query("UPDATE hn_thread_views SET requested_at=clock_timestamp()")
          .catch(() => {});
      }, 10000);
      stop.signal.addEventListener("abort", () => clearInterval(renewViews), {
        once: true,
      });
      await waitFor(
        async () =>
          (
            await pool.query(
              "SELECT DISTINCT story_id FROM hn_comments WHERE story_id=ANY($1::integer[])",
              [storyIds],
            )
          ).rowCount === 4,
      );
      const started = Date.now();
      const second = runSession(pool, { ...options, owner: "second" });
      sessions.push(second);
      const retired = await first;
      assert.equal(retired.transferred, true);
      await waitFor(async () =>
        (await pool.query("SELECT owner,state FROM ingest_status")).rows.some(
          (row) => row.owner === "second" && row.state === "healthy",
        ),
      );
      await waitFor(
        async () =>
          (
            await pool.query(
              "SELECT 1 FROM hn_threads WHERE story_id=ANY($1::integer[]) AND state='healthy'",
              [storyIds],
            )
          ).rowCount === 4,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT DISTINCT story_id FROM hn_comments WHERE story_id=ANY($1::integer[])",
            [storyIds],
          )
        ).rowCount,
        4,
      );
      const events = (
        await pool.query(
          "SELECT kind,occurred_at FROM ingest_events ORDER BY id",
        )
      ).rows;
      assert.ok(!events.some((row) => row.kind === "handoff_unavailable"));
      const promoted = +new Date(
        events.find((row) => row.kind === "promoted").occurred_at,
      );
      const handedOff = +new Date(
        events.find((row) => row.kind === "handoff").occurred_at,
      );
      assert.ok(promoted - handedOff <= 5000);
      const absolute = (
        await pool.query(
          "SELECT active_session_end,active_deadline FROM ingest_leases",
        )
      ).rows[0];
      assert.ok(
        +absolute.active_session_end <= +absolute.active_deadline - 10000,
      );
      await writeFile(
        new URL("../.local/handoff-results.json", import.meta.url),
        JSON.stringify(
          {
            measuredAt: new Date().toISOString(),
            environment:
              "isolated staging schema, real HN source, local workers",
            delayedStandbyToHealthyMs: Date.now() - started,
            handoffToPromotionMs: promoted - handedOff,
            simultaneousDiscussions: storyIds.length,
          },
          null,
          2,
        ),
      );
    } finally {
      stop.abort();
      await Promise.allSettled(sessions);
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
