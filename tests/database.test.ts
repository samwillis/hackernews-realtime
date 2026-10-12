import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { Leases, LostLease } from "../ingest/lease";
import { publish } from "../ingest/store";
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
      await pool.query(
        await readFile(
          new URL("../migrations/0001_hn.sql", import.meta.url),
          "utf8",
        ),
      );
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
      assert.equal(await publish(pool, winner, winnerToken, snapshot), 0);
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
