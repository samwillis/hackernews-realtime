import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { commentContent } from "../lib/comment-content";
import {
  parseStoryId,
  sortComments,
  THREAD_LIMIT,
  type Comment,
} from "../lib/comments";
import { orderedComments, selectComments } from "../ingest/threads";
const render = (html: string) =>
  renderToStaticMarkup(createElement("div", null, commentContent(html)));
test("HN comment formatting decodes entities and drops unsafe elements and links", () => {
  const markup = render(
    '<p>Hello &amp; <i>world</i><br><a href="https://example.com/?a=1&amp;b=2" onclick="alert(1)">link</a></p><pre><code>&lt;tag&gt;</code></pre>',
  );
  assert.match(markup, /Hello &amp; <i>world<\/i>/);
  assert.match(markup, /href="https:\/\/example.com\/\?a=1&amp;b=2"/);
  assert.match(markup, /&lt;tag&gt;/);
  const hostile = render(
    '<script>alert(1)</script><style>bad</style><img src=x onerror=bad><a href="javascript:alert(1)">bad link</a><a href="data:text/html,bad">data</a><a href="https://user:pass@example.com">credential</a><p style="color:red">text</p>',
  );
  assert.doesNotMatch(hostile, /script|style|img|href=|onerror|onclick|alert/);
  assert.match(hostile, /<span>bad link<\/span>/);
  assert.match(
    render('<a href="item?id=1">local</a>'),
    /href="https:\/\/news.ycombinator.com\/item\?id=1"/,
  );
});
test("comment tree preserves HN sibling order, depth and deleted parent placeholders", () => {
  const root = { id: 1, kids: [3, 2] };
  const items = new Map([
    [2, { id: 2 }],
    [3, { id: 3, deleted: true, kids: [4] }],
    [4, { id: 4, kids: [1, 3] }],
  ]);
  const rows = orderedComments(root, items);
  assert.deepEqual(
    rows.map((row) => [row.item.id, row.parentId, row.depth, row.path]),
    [
      [3, 1, 0, "000001"],
      [4, 3, 1, "000001.000001"],
      [2, 1, 0, "000002"],
    ],
  );
  const reordered = orderedComments({ ...root, kids: [2, 3] }, items);
  assert.deepEqual(
    reordered.map((row) => row.item.id),
    [2, 3, 4],
  );
});
test("thread traversal is bounded, handles cycles and rejects malformed story IDs", () => {
  const root = {
    id: 1,
    kids: Array.from({ length: THREAD_LIMIT + 10 }, (_, i) => i + 2),
  };
  assert.equal(selectComments(root, new Map()).ids.length, THREAD_LIMIT);
  assert.equal(selectComments(root, new Map()).truncated, true);
  assert.deepEqual(
    selectComments(
      { id: 1, kids: [1, 2, 2] },
      new Map([[2, { id: 2, kids: [1, 2, 3] }]]),
    ).ids,
    [2, 3],
  );
  for (const bad of [
    null,
    undefined,
    "01",
    "-1",
    "0",
    "1e3",
    "1;select",
    "2147483648",
    ["1"],
  ])
    assert.throws(() => parseStoryId(bad));
  assert.equal(parseStoryId("2147483647"), 2147483647);
  assert.deepEqual(
    sortComments(
      [
        [3, "000002"],
        [2, "000001.000001"],
        [1, "000001"],
      ].map(
        ([id, path]) =>
          ({
            item_id: Number(id),
            path: String(path),
            story_id: 1,
            parent_id: 1,
            depth: 0,
            author: null,
            created: 0,
            text: "",
            deleted: false,
            dead: false,
            committed_at: "",
          }) satisfies Comment,
      ),
    ).map((row) => row.item_id),
    [1, 2, 3],
  );
});
