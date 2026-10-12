import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventBuckets,
  eventDescription,
  inViewport,
  TIMELINE_MS,
  type HnEvent,
} from "../lib/events";
const event = (id: number, occurred_at: number): HnEvent => ({
  event_id: id,
  item_id: id,
  story_id: id,
  kind: "story-updated",
  label: "Story",
  details: '{"score":{"from":"1","to":"2"},"comments":{"from":"0","to":"1"}}',
  occurred_at,
});
test("timeline keeps every event in busy bursts, independent of item or kind", () => {
  const now = 180000;
  const events = Array.from({ length: 1500 }, (_, i) => ({
    ...event(i, now - 1000),
    kind: i % 2 ? "comment-removed" : "new-left",
  }));
  const buckets = eventBuckets(
    [
      ...events,
      event(1501, now - TIMELINE_MS),
      event(1502, now - TIMELINE_MS - 1),
      event(1503, now + 1),
    ],
    now,
  );
  assert.equal(buckets.flatMap((bucket) => bucket.events).length, 1501);
  assert.equal(buckets[1].events.length, 1500);
  assert.equal(buckets[0].events[0].event_id, 1501);
  assert.equal(eventBuckets(events, now + TIMELINE_MS).length, 0);
});
test("visibility uses the unobscured viewport and includes partially visible rows", () => {
  assert.equal(
    inViewport({ top: 500, bottom: 650, left: 0, right: 600 }, 600, 550),
    true,
  );
  assert.equal(
    inViewport({ top: 550, bottom: 650, left: 0, right: 600 }, 600, 550),
    false,
  );
  assert.equal(
    inViewport({ top: -100, bottom: 1, left: 0, right: 600 }, 600, 550),
    true,
  );
  assert.equal(
    inViewport({ top: -100, bottom: 0, left: 0, right: 600 }, 600, 550),
    false,
  );
});
test("event details retain every changed field and tolerate malformed payloads", () => {
  assert.equal(
    eventDescription(event(1, 0)),
    "story updated · score: 1 → 2 · comment count: 0 → 1",
  );
  assert.equal(
    eventDescription({ ...event(1, 0), details: "oops" }),
    "story updated",
  );
  assert.equal(
    eventDescription({
      ...event(1, 0),
      kind: "comment-updated",
      details:
        '{"text":{"from":"<p>A &amp; B</p>","to":"<p>Updated <i>reply</i></p>"}}',
    }),
    "comment updated · text: A & B → Updated reply",
  );
});
