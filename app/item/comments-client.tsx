"use client";
import { useCallback, useMemo, useState } from "react";
import { useLiveQuery } from "@neon/realtime-react";
import type { SealedComments, SealedStory } from "@/lib/queries";
import { sortStories, type Story } from "@/lib/types";
import { sortComments, THREAD_LIMIT, type Comment } from "@/lib/comments";
import { commentContent } from "@/lib/comment-content";
import { age, HN, itemLink, userLink } from "@/lib/links";
import { Footer, Header, LiveProvider, useLiveControls } from "../live-ui";
import { StoryRow } from "../story-row";
import { useLiveList } from "../use-live-list";
const storyFields = ["score", "comments", "title", "body"] as const;
const commentFields = ["text", "deleted", "dead"] as const;
type Queries = { story: SealedStory; comments: SealedComments };
type Props = {
  initialStories: Story[];
  initialComments: Comment[];
  queries: Queries | null;
  initialNow: number;
};
export function CommentsClient(props: Props) {
  if (!props.queries)
    return (
      <Discussion
        {...props}
        stories={props.initialStories}
        comments={props.initialComments}
        connection="fixture"
      />
    );
  return (
    <LiveProvider>
      <LiveDiscussion {...props} queries={props.queries} />
    </LiveProvider>
  );
}
function LiveDiscussion(props: Props & { queries: Queries }) {
  const id = props.initialStories[0].item_id;
  const renew = useCallback(async () => {
    const response = await fetch(`/api/thread/live?id=${id}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Unable to renew the discussion");
    return response.json() as Promise<Queries>;
  }, [id]);
  const refreshStory = useCallback(async () => (await renew()).story, [renew]);
  const refreshComments = useCallback(
    async () => (await renew()).comments,
    [renew],
  );
  const story = useLiveQuery(props.queries.story, {
    initialData: props.initialStories,
    refreshQuery: refreshStory,
  });
  const comments = useLiveQuery(props.queries.comments, {
    initialData: props.initialComments,
    refreshQuery: refreshComments,
  });
  const connection = [story.status, comments.status].includes("error")
    ? "error"
    : [story.status, comments.status].includes("stale")
      ? "stale"
      : story.status === "live" && comments.status === "live"
        ? "live"
        : "connecting";
  return (
    <Discussion
      {...props}
      stories={story.data ?? props.initialStories}
      comments={comments.data ?? props.initialComments}
      connection={connection}
      error={story.error?.message ?? comments.error?.message}
    />
  );
}
export function Discussion({
  initialStories,
  initialComments,
  stories,
  comments,
  connection,
  error,
  initialNow,
}: Props & {
  stories: readonly Story[];
  comments: readonly Comment[];
  connection: string;
  error?: string;
}) {
  const id = initialStories[0].item_id;
  const controls = useLiveControls(
    initialNow,
    connection,
    `/api/thread/watch?id=${id}`,
    "POST",
  );
  const liveStory = useLiveList(
    initialStories,
    stories,
    sortStories,
    storyFields,
    controls.paused,
    controls.highlight,
    initialNow,
  );
  const list = useLiveList(
    initialComments,
    comments,
    sortComments,
    commentFields,
    controls.paused,
    controls.highlight,
    initialNow,
  );
  const story = liveStory.rows[0] ?? initialStories[0];
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const visible = useMemo(() => {
    const hidden: string[] = [];
    return list.rows.filter((row) => {
      if (hidden.some((path) => row.path.startsWith(`${path}.`))) return false;
      if (collapsed.has(row.item_id)) hidden.push(row.path);
      return true;
    });
  }, [list.rows, collapsed]);
  const toggle = (id: number) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const limited =
    controls.health &&
    "truncated" in controls.health &&
    controls.health.truncated;
  return (
    <main className="hn-page">
      <Header controls={controls} connection={connection} error={error} />
      <article
        className="thread-story"
        ref={(node) => liveStory.register(story.item_id, node)}
      >
        <StoryRow
          story={story}
          change={liveStory.changes.get(story.item_id)}
          now={controls.now}
          thread
        />
        {story.body && (
          <div
            key={liveStory.changes.get(story.item_id)?.fields.body ?? 0}
            className={`story-body comment-text ${liveStory.changes.get(story.item_id)?.fields.body ? "changed-value" : ""}`}
          >
            {commentContent(story.body)}
          </div>
        )}
      </article>
      <p className="discussion-actions">
        <a href={itemLink(id)}>Comment on Hacker News</a>
      </p>
      <ol id="comments" className="comments" aria-label="Story comments">
        {visible.map((comment) => {
          const change = list.changes.get(comment.item_id);
          const closed = collapsed.has(comment.item_id);
          const edited =
            change?.fields.text ||
            change?.fields.deleted ||
            change?.fields.dead;
          return (
            <li
              key={comment.item_id}
              id={`comment-${comment.item_id}`}
              data-item-id={comment.item_id}
              data-committed-at={comment.committed_at}
              data-applied-at={list.appliedAt}
              className={`comment ${change?.entered || change?.moved ? "changed-row" : ""}`}
              style={
                {
                  "--depth": Math.min(comment.depth, 12),
                } as React.CSSProperties
              }
              ref={(node) => list.register(comment.item_id, node)}
            >
              <div className="comment-meta">
                <a
                  className={`vote ${comment.deleted || comment.dead ? "no-vote" : ""}`}
                  href={itemLink(comment.item_id)}
                  aria-label="Vote on this comment at Hacker News"
                >
                  <span />
                </a>
                {comment.author && (
                  <>
                    <a href={userLink(comment.author)}>{comment.author}</a>{" "}
                  </>
                )}
                <a href={itemLink(comment.item_id)}>
                  {age(comment.created, controls.now)}
                </a>{" "}
                <button
                  type="button"
                  onClick={() => toggle(comment.item_id)}
                  aria-expanded={!closed}
                  aria-label={`${closed ? "Expand" : "Collapse"} comment by ${comment.author ?? "unknown"}`}
                >
                  {closed ? "[+]" : "[–]"}
                </button>
              </div>
              {!closed && (
                <div className="comment-content">
                  <div
                    key={edited ?? 0}
                    data-change={edited ? "text" : undefined}
                    className={`comment-text ${edited ? "changed-value" : ""} ${comment.dead ? "dead-comment" : ""}`}
                  >
                    {comment.deleted
                      ? "[deleted]"
                      : comment.dead
                        ? "[dead]"
                        : commentContent(comment.text)}
                  </div>
                  {!comment.deleted && !comment.dead && (
                    <a
                      className="reply"
                      href={`${HN}/reply?id=${comment.item_id}&goto=item%3Fid%3D${id}`}
                    >
                      reply
                    </a>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!list.rows.length && (
        <p className="discussion-empty" role="status">
          {story.comments === 0
            ? "No comments yet."
            : controls.health?.state === "busy"
              ? "Live updates are busy. This thread will load when a slot is available."
              : controls.health?.state === "degraded"
                ? "Comments are temporarily unavailable."
                : "Loading comments…"}{" "}
          <a href={itemLink(id)}>View on Hacker News</a>
        </p>
      )}
      {limited && (
        <p className="thread-limit">
          Showing up to {THREAD_LIMIT} comments.{" "}
          <a href={itemLink(id)}>Read the full discussion on Hacker News</a>.
        </p>
      )}
      <Footer />
    </main>
  );
}
