"use client";
import { useEffect, useRef, useState } from "react";
import { News } from "../../news-client";
import { Discussion } from "../../item/comments-client";
import type { Story } from "@/lib/types";
import type { Comment } from "@/lib/comments";
import type { HnEvent } from "@/lib/events";
const initialComments: Comment[] = [
  {
    story_id: 1000,
    item_id: 501,
    parent_id: 1000,
    path: "000001",
    depth: 0,
    author: "alice",
    created: 1791806400,
    text: 'A comment with <i>formatting</i> &amp; a <a href="https://neon.com">link</a>.',
    deleted: false,
    dead: false,
    committed_at: "2026-10-12T08:00:00.000Z",
  },
  {
    story_id: 1000,
    item_id: 502,
    parent_id: 501,
    path: "000001.000001",
    depth: 1,
    author: "bob",
    created: 1791806500,
    text: "A nested reply.<p>With a second paragraph.</p>",
    deleted: false,
    dead: false,
    committed_at: "2026-10-12T08:00:00.000Z",
  },
  {
    story_id: 1000,
    item_id: 503,
    parent_id: 1000,
    path: "000002",
    depth: 0,
    author: "carol",
    created: 1791806600,
    text: "Another top-level comment.",
    deleted: false,
    dead: false,
    committed_at: "2026-10-12T08:00:00.000Z",
  },
];
export function UpdateFixture({
  initialStories,
  initialNow,
}: {
  initialStories: Story[];
  initialNow: number;
}) {
  const [view, setView] = useState("stories");
  const [stories, setStories] = useState(initialStories);
  const [comments, setComments] = useState(initialComments);
  const [events, setEvents] = useState<HnEvent[]>(() => [
    ...initialStories.map((story, index) => ({
      event_id: index + 1,
      item_id: story.item_id,
      story_id: story.item_id,
      kind: "story-updated",
      label: story.title,
      details: '{"score":{"from":"1","to":"2"}}',
      occurred_at: initialNow - 60000 + index * 1500,
    })),
    {
      event_id: 100,
      item_id: 99999,
      story_id: 99999,
      kind: "new-left",
      label: "An item on another page",
      details: '{"rank":150}',
      occurred_at: initialNow - 8000,
    },
    {
      event_id: 101,
      item_id: 501,
      story_id: 1000,
      kind: "comment-updated",
      label: "Comment by alice",
      details: '{"text":{"from":"old","to":"new"}}',
      occurred_at: initialNow - 5000,
    },
  ]);
  const sequence = useRef(1000);
  const previous = useRef<{ stories: Story[]; comments: Comment[] }>({
    stories,
    comments,
  });
  useEffect(() => {
    const added: HnEvent[] = [];
    for (const type of ["stories", "comments"] as const) {
      const old = new Map(
        previous.current[type].map((row) => [row.item_id, row]),
      );
      const current = type === "stories" ? stories : comments;
      for (const row of current) {
        const prior = old.get(row.item_id);
        const delta: Record<string, unknown> = {};
        if (prior)
          for (const field of Object.keys(row)) {
            const before = (prior as unknown as Record<string, unknown>)[field];
            const after = (row as unknown as Record<string, unknown>)[field];
            if (field !== "committed_at" && before !== after)
              delta[field] = { from: before, to: after };
          }
        if (!prior || Object.keys(delta).length)
          added.push({
            event_id: sequence.current++,
            item_id: row.item_id,
            story_id: "story_id" in row ? row.story_id : row.item_id,
            kind: `${type === "stories" ? "story" : "comment"}-${prior ? "updated" : "added"}`,
            label: "title" in row ? row.title : `Comment by ${row.author}`,
            details: JSON.stringify(delta),
            occurred_at: Date.now(),
          });
        old.delete(row.item_id);
      }
      for (const row of old.values())
        added.push({
          event_id: sequence.current++,
          item_id: row.item_id,
          story_id: "story_id" in row ? row.story_id : row.item_id,
          kind: `${type === "stories" ? "story" : "comment"}-removed`,
          label: "title" in row ? row.title : `Comment by ${row.author}`,
          details: "{}",
          occurred_at: Date.now(),
        });
    }
    previous.current = { stories, comments };
    if (added.length) setEvents((rows) => [...rows, ...added]);
  }, [stories, comments]);
  return (
    <>
      <div
        style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap" }}
        aria-label="Development update fixtures"
      >
        <button
          onClick={() => setView(view === "stories" ? "comments" : "stories")}
        >
          {view === "stories" ? "Test comments" : "Test stories"}
        </button>
        <button
          onClick={() =>
            setStories((rows) =>
              rows.map((row, i) =>
                i === 0
                  ? {
                      ...row,
                      score: row.score + 1,
                      committed_at: new Date().toISOString(),
                    }
                  : row,
              ),
            )
          }
        >
          Change score
        </button>
        <button
          onClick={() =>
            setStories((rows) =>
              rows.map((row, i) =>
                i === 0
                  ? {
                      ...row,
                      comments: row.comments + 1,
                      committed_at: new Date().toISOString(),
                    }
                  : row,
              ),
            )
          }
        >
          Change count
        </button>
        <button
          onClick={() => {
            if (view === "stories")
              setStories((rows) => [
                {
                  ...initialStories[0],
                  item_id: 9000 + rows.length,
                  rank: 1,
                  title:
                    "A newly arriving story with enough text to wrap onto a second line on a narrow screen",
                  committed_at: new Date().toISOString(),
                },
                ...rows.map((row) => ({ ...row, rank: row.rank + 1 })),
              ]);
            else
              setComments((rows) => [
                ...rows.map((row) => ({
                  ...row,
                  path: row.path.replace(/^[0-9]{6}/, (prefix) =>
                    String(Number(prefix) + 1).padStart(6, "0"),
                  ),
                })),
                {
                  ...initialComments[0],
                  item_id: 9000 + rows.length,
                  path: "000001",
                  text: "A new comment that expands into the thread.<p>The new row has two paragraphs.</p>",
                  committed_at: new Date().toISOString(),
                },
              ]);
          }}
        >
          Insert row
        </button>
        <button
          onClick={() => {
            if (view === "stories")
              setStories((rows) =>
                rows.map((row) => ({
                  ...row,
                  rank: rows.length - row.rank + 1,
                })),
              );
            else
              setComments((rows) =>
                rows.map((row) => ({
                  ...row,
                  path: row.path.startsWith("000001")
                    ? row.path.replace(/^000001/, "000002")
                    : row.path.startsWith("000002")
                      ? row.path.replace(/^000002/, "000001")
                      : row.path,
                })),
              );
          }}
        >
          Move rows
        </button>
        <button
          onClick={() =>
            setComments((rows) =>
              rows.map((row) =>
                row.item_id === 501
                  ? {
                      ...row,
                      text: `${row.text}<p>An edited paragraph.</p>`,
                      committed_at: new Date().toISOString(),
                    }
                  : row,
              ),
            )
          }
        >
          Edit comment
        </button>
        <button
          onClick={() =>
            setComments((rows) =>
              rows.map((row) =>
                row.item_id === 502
                  ? {
                      ...row,
                      text: `${row.text}<p>Edited reply.</p>`,
                      committed_at: new Date().toISOString(),
                    }
                  : row,
              ),
            )
          }
        >
          Edit reply
        </button>
        <button
          onClick={() => {
            setStories(initialStories);
            setComments(initialComments);
          }}
        >
          Reset fixture
        </button>
        <button
          onClick={() =>
            setEvents((rows) => [
              ...rows,
              {
                event_id: sequence.current++,
                item_id: 99999,
                story_id: 99999,
                kind: "comment-removed",
                label: "Offscreen comment",
                details: "{}",
                occurred_at: Date.now(),
              },
            ])
          }
        >
          Offscreen event
        </button>
        <button
          onClick={() =>
            view === "stories"
              ? setStories((rows) => rows.slice(1))
              : setComments((rows) => rows.filter((row) => row.item_id !== 503))
          }
        >
          Remove row
        </button>
      </div>
      {view === "stories" ? (
        <News
          feed="top"
          page={1}
          query={null}
          initialRows={initialStories}
          rows={stories}
          initialNow={initialNow}
          connection="fixture"
          fixtureEvents={events}
        />
      ) : (
        <Discussion
          initialStories={initialStories.slice(0, 1)}
          stories={stories.filter((row) => row.item_id === 1000)}
          initialComments={initialComments}
          comments={comments}
          queries={null}
          initialNow={initialNow}
          connection="fixture"
          fixtureEvents={events}
        />
      )}
    </>
  );
}
