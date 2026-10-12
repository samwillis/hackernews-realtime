import { test } from "node:test";
import assert from "node:assert/strict";
import { sortStories, parseFeedPage, type Story } from "../lib/types";
import { articleLink, decodeTitle, userLink } from "../lib/links";
import { itemRecord } from "../ingest/store";
const row = (id: number, rank: number) => ({ item_id: id, rank }) as Story;
test("ranks reorder stable IDs, including inserted rows, resets and page boundaries", () => {
  const before = [row(1, 1), row(2, 2), row(3, 30)];
  const after = [row(1, 31), row(2, 1), row(4, 2), row(3, 3)];
  assert.deepEqual(
    sortStories(after).map((r) => r.item_id),
    [2, 4, 3, 1],
  );
  assert.deepEqual(
    before.map((r) => r.item_id),
    [1, 2, 3],
  );
  assert.deepEqual(
    sortStories([row(5, 2), row(4, 2)]).map((r) => r.item_id),
    [4, 5],
  );
});
test("sealed feed inputs are bounded", () => {
  assert.deepEqual(parseFeedPage("new", "5"), { feed: "new", page: 5 });
  for (const input of ["0", "6", "1.0", "NaN", "-1", "1 OR 1=1"])
    assert.throws(() => parseFeedPage("top", input));
  assert.throws(() => parseFeedPage("anything", "1"));
});
test("HN titles render as text and outbound links use safe protocols", () => {
  assert.equal(decodeTitle("A &amp; B &#x3C;script&#x3E;"), "A & B <script>");
  assert.equal(
    articleLink("javascript:alert(1)", 12),
    "https://news.ycombinator.com/item?id=12",
  );
  assert.equal(
    articleLink(null, 12),
    "https://news.ycombinator.com/item?id=12",
  );
  assert.equal(userLink("a&b"), "https://news.ycombinator.com/user?id=a%26b");
});
test("null, removed, incomplete and job items have safe database representations", () => {
  assert.equal(itemRecord({ id: 1, deleted: true }, "now").deleted, true);
  assert.equal(
    itemRecord({ id: 1, title: "gone", dead: true }, "now").dead,
    true,
  );
  assert.equal(
    itemRecord({ id: 2, type: "job", title: "Hiring" }, "now").score,
    0,
  );
});
