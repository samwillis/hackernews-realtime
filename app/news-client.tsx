"use client";
import { useCallback } from "react";
import { LiveLink as Link } from "./live-link";
import { useCachedLiveQuery, useSession } from "./live-session";
import type { SealedFeed } from "@/lib/queries";
import { sortStories, type Feed, type Story } from "@/lib/types";
import { Header, useLiveControls } from "./live-ui";
import { StoryRow } from "./story-row";
import { useLiveList } from "./use-live-list";
import { EventTimeline } from "./event-timeline";
import type { HnEvent } from "@/lib/events";
const fields = ["score", "comments", "title"] as const;
const emptyEvents: HnEvent[] = [];
type Props = {
  feed: Feed;
  page: number;
  initialRows: Story[];
  query: SealedFeed | null;
  initialNow: number;
  fixtureEvents?: readonly HnEvent[];
};
export function NewsClient(props: Props) {
  if (!props.query)
    return <News {...props} rows={props.initialRows} connection="fixture" />;
  return <LiveNews {...props} query={props.query} />;
}
function LiveNews(props: Props & { query: SealedFeed }) {
  const session = useSession();
  const refreshQuery = useCallback(async () => {
    return session.json<SealedFeed>(
      `/api/feed/live?feed=${props.feed}&page=${props.page}`,
    );
  }, [session, props.feed, props.page]);
  const { data, status, error } = useCachedLiveQuery(
    `feed:${props.feed}:${props.page}`,
    props.query,
    props.initialRows,
    refreshQuery,
  );
  return (
    <News
      {...props}
      initialRows={data ? [...data] : props.initialRows}
      rows={data ?? props.initialRows}
      connection={status}
      error={error?.message}
    />
  );
}
export function News({
  feed,
  page,
  initialRows,
  rows,
  connection,
  error,
  initialNow,
  fixtureEvents,
}: Props & { rows: readonly Story[]; connection: string; error?: string }) {
  const controls = useLiveControls(initialNow, connection);
  const list = useLiveList(
    initialRows,
    rows,
    sortStories,
    fields,
    controls.paused,
    controls.highlight,
    initialNow,
  );
  return (
    <main className="hn-page">
      <Header
        feed={feed}
        controls={controls}
        connection={connection}
        error={error}
      />
      <ol className="stories" start={(page - 1) * 30 + 1}>
        {list.rows.map((story) => {
          const change = list.changes.get(story.item_id);
          return (
            <li
              key={story.item_id}
              data-item-id={story.item_id}
              data-committed-at={story.committed_at}
              data-applied-at={list.appliedAt}
              className={`story ${change?.entered || change?.moved ? "changed-row" : ""}`}
              ref={(node) => list.register(story.item_id, node)}
            >
              <StoryRow story={story} change={change} now={controls.now} />
            </li>
          );
        })}
      </ol>
      {!list.rows.length && (
        <p className="empty">
          No stories on this page yet.{" "}
          <Link href="/">Back to the front page</Link>
        </p>
      )}
      {page < 5 && (
        <Link className="more" href={`/?feed=${feed}&page=${page + 1}`}>
          More
        </Link>
      )}
      {connection === "fixture" && (
        <EventTimeline
          paused={controls.paused}
          fixtureEvents={fixtureEvents ?? emptyEvents}
        />
      )}
    </main>
  );
}
