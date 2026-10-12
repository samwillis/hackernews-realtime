import { test } from "node:test";
import assert from "node:assert/strict";
import { firstComments } from "../ingest/thread-load";

test("first render reads one small parallel batch rather than a whole discussion", async () => {
  const requests: string[] = [];
  const snapshot = await firstComments(1, async (path) => {
    requests.push(path);
    const id = Number(path.slice(5));
    return id === 1
      ? {
          id,
          type: "story",
          descendants: 200,
          kids: Array.from({ length: 50 }, (_, i) => i + 2),
        }
      : { id, type: "comment", text: `Comment ${id}`, kids: [id + 1000] };
  });
  assert.equal(requests.length, 21);
  assert.equal(snapshot.rows.length, 20);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.rows[19].path, "000020");
  assert.ok(!requests.includes("item/1002"));
});

test("empty/small threads complete immediately, including deleted placeholders", async () => {
  const empty = await firstComments(1, async () => ({ id: 1, type: "story" }));
  assert.equal(empty.complete, true);
  assert.deepEqual(empty.rows, []);
  const small = await firstComments(1, async (path) =>
    path === "item/1" ? { id: 1, type: "story", kids: [2] } : null,
  );
  assert.equal(small.complete, true);
  assert.equal(small.rows[0].item.deleted, true);
  await assert.rejects(
    firstComments(1, async () => null),
    /unavailable/,
  );
});
