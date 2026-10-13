import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { spreadChanges, type PendingChange } from "../ingest/smoothing";
import { itemRecord } from "../ingest/store";
import { commentRecords } from "../ingest/thread-store";
import { runSession } from "../ingest/session";

const item = (id: number, due_at = -1): PendingChange => ({
  key: `item:${id}`,
  due_at,
  received_at: 1000,
  revision: 1,
  payload: {
    kind: "item",
    record: itemRecord({ id, title: `Story ${id}` }, ""),
  },
});

test("smoothing spreads a burst across its window without postponing pending work", () => {
  const pending = item(9, 2500);
  const changes = spreadChanges(
    [item(4), item(2), pending, item(1), item(3)],
    1000,
    28000,
  );
  assert.deepEqual(
    changes
      .filter((job) => job.key !== "item:9")
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((job) => job.due_at),
    [6600, 12200, 17800, 23400],
  );
  assert.equal(pending.due_at, 2500);
  assert.equal(spreadChanges([item(1), item(2)], 1000, 0)[0].due_at, 1000);
});

test("new reply edits wait for their tree; existing comment edits are independent", () => {
  const thread = {
    story: { id: 1, title: "One" },
    receivedAt: 1000,
    truncated: false,
    rows: [
      {
        item: { id: 11, text: "Reply" },
        parentId: 1,
        path: "000001",
        depth: 0,
      },
    ],
  };
  const edit: PendingChange = {
    key: "comment:1:11",
    due_at: -1,
    received_at: 1000,
    revision: 1,
    payload: {
      kind: "comment",
      record: commentRecords(thread, "")[0],
      afterStructure: true,
    },
  };
  const existing = {
    ...edit,
    key: "comment:1:12",
    payload: { ...edit.payload, afterStructure: false },
  } as PendingChange;
  const tree: PendingChange = {
    key: "thread:1",
    due_at: 20000,
    received_at: 1000,
    revision: 1,
    payload: { kind: "thread", thread },
  };
  spreadChanges([edit, existing, tree], 1000, 28000);
  assert.equal(edit.due_at, 20000);
  assert.ok(existing.due_at < 20000);
  assert.equal(tree.due_at, 20000);
});

test("invalid smoothing config fails before acquiring the database", async () => {
  const pool = new Pool();
  try {
    for (const smoothingMs of [NaN, Infinity, -1, 1.5, 60001])
      await assert.rejects(
        runSession(pool, { smoothingMs }),
        /Invalid ingestion smoothing/,
      );
  } finally {
    await pool.end();
  }
});
