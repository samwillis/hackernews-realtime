import { test } from "node:test";
import assert from "node:assert/strict";
import { rowChanges, HIGHLIGHT_MS } from "../lib/changes";
test("numbers pulse independently across successive snapshots", () => {
  const before = [
    { item_id: 1, score: 10, comments: 3 },
    { item_id: 2, score: 8, comments: 1 },
  ];
  const score = [{ ...before[0], score: 11 }, before[1]];
  const first = rowChanges(
    before,
    score,
    ["score", "comments"],
    new Map(),
    1000,
  );
  assert.deepEqual(first.get(1), {
    fields: { score: 1000 },
    entered: undefined,
    moved: undefined,
  });
  assert.equal(first.has(2), false);
  const counts = [{ ...score[0], comments: 4 }, before[1]];
  const second = rowChanges(score, counts, ["score", "comments"], first, 1500);
  assert.deepEqual(second.get(1)?.fields, { score: 1000, comments: 1500 });
  const expired = rowChanges(counts, counts, [], second, 1000 + HIGHLIGHT_MS);
  assert.deepEqual(expired.get(1)?.fields, { comments: 1500 });
  assert.equal(
    rowChanges(counts, counts, [], expired, 1500 + HIGHLIGHT_MS).size,
    0,
  );
});
test("arrivals, moves and removed rows are distinguished", () => {
  const before = [
    { item_id: 1, score: 1 },
    { item_id: 2, score: 2 },
  ];
  const after = [{ item_id: 3, score: 3 }, before[1], before[0]];
  const changes = rowChanges(before, after, ["score"], new Map(), 1000);
  assert.equal(changes.get(3)?.entered, 1000);
  assert.deepEqual(changes.get(3)?.fields, {});
  assert.equal(changes.has(2), false);
  assert.equal(changes.get(1)?.moved, 1000);
  const removed = rowChanges(after, [after[1]], ["score"], changes, 1100);
  assert.equal(removed.has(1), false);
  assert.equal(removed.has(3), false);
});
