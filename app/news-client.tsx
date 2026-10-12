"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { createRealtimeClient } from "@neon/realtime/client";
import { RealtimeProvider, useLiveQuery } from "@neon/realtime-react";
import type { SealedFeed } from "@/lib/queries";
import {
  sortStories,
  type Feed,
  type SourceHealth,
  type Story,
} from "@/lib/types";
import {
  age,
  articleLink,
  decodeTitle,
  domain,
  HN,
  itemLink,
  userLink,
} from "@/lib/links";

type Props = {
  feed: Feed;
  page: number;
  initialRows: Story[];
  query: SealedFeed | null;
  initialNow: number;
};
export function NewsClient(props: Props) {
  if (!props.query)
    return <News {...props} rows={props.initialRows} connection="fixture" />;
  return <ConnectedNews {...props} query={props.query} />;
}
function ConnectedNews(props: Props & { query: SealedFeed }) {
  const [client] = useState(() =>
    createRealtimeClient({ url: process.env.NEXT_PUBLIC_NEON_REALTIME_URL! }),
  );
  return (
    <RealtimeProvider client={client}>
      <LiveNews {...props} />
    </RealtimeProvider>
  );
}
function LiveNews(props: Props & { query: SealedFeed }) {
  const refreshQuery = useCallback(async () => {
    const response = await fetch(
      `/api/feed/live?feed=${props.feed}&page=${props.page}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Unable to renew the live connection");
    return response.json() as Promise<SealedFeed>;
  }, [props.feed, props.page]);
  const { data, status, error } = useLiveQuery(props.query, {
    initialData: props.initialRows,
    refreshQuery,
  });
  return (
    <News
      {...props}
      rows={data ?? props.initialRows}
      connection={status}
      error={error?.message}
    />
  );
}
function News({
  feed,
  page,
  initialRows,
  rows,
  connection,
  error,
  initialNow,
}: Props & { rows: readonly Story[]; connection: string; error?: string }) {
  const [paused, setPaused] = useState(false);
  const [highlight, setHighlight] = useState(true);
  const [displayed, setDisplayed] = useState(() => sortStories(initialRows));
  const [changed, setChanged] = useState<Set<number>>(new Set());
  const [appliedAt, setAppliedAt] = useState(initialNow);
  const [now, setNow] = useState(initialNow);
  const [health, setHealth] = useState<SourceHealth | null>(null);
  const previous = useRef(initialRows);
  const suppressHighlight = useRef(false);
  const rowNodes = useRef(new Map<number, HTMLLIElement>());
  const positions = useRef(new Map<number, number>());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    if (connection === "fixture") return () => clearInterval(timer);
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const value = (await response.json()) as SourceHealth;
        if (!disposed) setHealth(value);
      } catch {
        if (!disposed)
          setHealth({ state: "degraded", checkedAt: null, committedAt: null });
      }
    };
    void refresh();
    const healthTimer = setInterval(() => void refresh(), 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearInterval(healthTimer);
    };
  }, [connection === "fixture"]);
  useEffect(() => {
    if (paused) return;
    const sorted = sortStories(rows);
    const old = new Map(previous.current.map((row) => [row.item_id, row]));
    const updates = new Set(
      sorted
        .filter((row) => {
          const before = old.get(row.item_id);
          return (
            !before ||
            before.score !== row.score ||
            before.comments !== row.comments ||
            before.rank !== row.rank ||
            before.title !== row.title
          );
        })
        .map((row) => row.item_id),
    );
    setChanged(highlight && !suppressHighlight.current ? updates : new Set());
    const resuming = suppressHighlight.current;
    suppressHighlight.current = false;
    previous.current = sorted;
    setDisplayed(sorted);
    const applied = Date.now();
    setAppliedAt(applied);
    if (process.env.NEXT_PUBLIC_MEASURE_REALTIME === "1" && !resuming) {
      for (const row of sorted) {
        const before = old.get(row.item_id);
        if (before && before.committed_at !== row.committed_at)
          console.debug(
            "hn_realtime_applied",
            JSON.stringify({
              id: row.item_id,
              committedAt: row.committed_at,
              appliedAt: applied,
              latencyMs: applied - Date.parse(row.committed_at),
            }),
          );
      }
    }
    const timer = setTimeout(() => setChanged(new Set()), 1800);
    return () => clearTimeout(timer);
  }, [rows, paused, highlight]);
  useLayoutEffect(() => {
    const next = new Map<number, number>();
    for (const [id, node] of rowNodes.current) {
      const y = node.getBoundingClientRect().top;
      const before = positions.current.get(id);
      if (
        before !== undefined &&
        before !== y &&
        highlight &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        node.animate(
          [
            { transform: `translateY(${before - y}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: 200, easing: "ease-out" },
        );
      }
      next.set(id, y);
    }
    positions.current = next;
  }, [displayed, highlight]);
  const fresh =
    health?.checkedAt &&
    now - Date.parse(health.checkedAt) < 30000 &&
    health.state === "healthy";
  const connected = connection === "live";
  return (
    <main className="hn-page">
      <header className="hn-header">
        <Link href="/" className="logo" aria-label="Hacker News home">
          Y
        </Link>
        <div className="header-content">
          <Link href="/" className="site-title">
            Hacker News
          </Link>
          <nav aria-label="Main navigation">
            <Link
              href="/?feed=new"
              className={feed === "new" ? "selected" : ""}
            >
              new
            </Link>
            <span> | </span>
            <a href={`${HN}/threads`}>threads</a>
            <span> | </span>
            <a href={`${HN}/past`}>past</a>
            <span> | </span>
            <a href={`${HN}/newcomments`}>comments</a>
            <span> | </span>
            <a href={`${HN}/ask`}>ask</a>
            <span> | </span>
            <a href={`${HN}/show`}>show</a>
            <span> | </span>
            <a href={`${HN}/jobs`}>jobs</a>
            <span> | </span>
            <a href={`${HN}/submit`}>submit</a>
          </nav>
        </div>
        <a className="login" href={`${HN}/login`}>
          login
        </a>
      </header>
      <div className="live-controls">
        <button
          type="button"
          onClick={() => {
            if (paused) suppressHighlight.current = true;
            setPaused(!paused);
          }}
          aria-pressed={paused}
          aria-label={paused ? "Resume live updates" : "Pause live updates"}
        >
          <span
            className={`live-dot ${paused ? "paused" : connected ? "on" : ""}`}
          />
          {paused ? "resume" : "pause"}
        </button>
        <span className="separator"> | </span>
        <label>
          <input
            type="checkbox"
            checked={highlight}
            onChange={(event) => setHighlight(event.target.checked)}
          />{" "}
          highlight changes
        </label>
        <span className="separator"> | </span>
        <span role="status" title={error ?? undefined}>
          {connection === "fixture"
            ? "development fixture"
            : paused
              ? "paused"
              : connected
                ? "live"
                : connection === "error"
                  ? "connection lost"
                  : connection === "stale"
                    ? "reconnecting…"
                    : "connecting…"}
        </span>
        {connection === "error" && (
          <button onClick={() => window.location.reload()}>reconnect</button>
        )}
        {connection !== "fixture" && (
          <>
            <span className="separator"> · </span>
            <span className={health && !fresh ? "source-stale" : ""}>
              {!health
                ? "checking source…"
                : fresh
                  ? "HN connected"
                  : health.state === "reconnecting"
                    ? "HN reconnecting…"
                    : "HN data may be stale"}
            </span>
          </>
        )}
      </div>
      <ol className="stories" start={(page - 1) * 30 + 1}>
        {displayed.map((story) => (
          <li
            key={story.item_id}
            data-item-id={story.item_id}
            data-committed-at={story.committed_at}
            data-applied-at={appliedAt}
            className={`story ${changed.has(story.item_id) ? "changed" : ""}`}
            ref={(node) => {
              if (node) rowNodes.current.set(story.item_id, node);
              else rowNodes.current.delete(story.item_id);
            }}
          >
            <div className="story-main">
              <span className="rank">{story.rank}.</span>
              <a
                className={`vote ${story.type === "job" ? "no-vote" : ""}`}
                href={itemLink(story.item_id)}
                aria-label={`Vote on ${decodeTitle(story.title)} at Hacker News`}
              >
                <span />
              </a>
              <span className="titleline">
                <a
                  className="story-title"
                  href={articleLink(story.url, story.item_id)}
                >
                  {decodeTitle(story.title)}
                </a>
                {domain(story.url) && (
                  <span className="domain">
                    {" "}
                    (
                    <a
                      href={`${HN}/from?site=${encodeURIComponent(domain(story.url)!)}`}
                    >
                      {domain(story.url)}
                    </a>
                    )
                  </span>
                )}
              </span>
            </div>
            <div className="subtext">
              {story.type !== "job" && (
                <>
                  {story.score} point{story.score === 1 ? "" : "s"}
                  {story.author && (
                    <>
                      {" "}
                      by <a href={userLink(story.author)}>{story.author}</a>
                    </>
                  )}{" "}
                </>
              )}
              <a href={itemLink(story.item_id)}>{age(story.created, now)}</a>
              {story.type !== "job" && (
                <>
                  <span> | </span>
                  <a href={itemLink(story.item_id)}>
                    {story.comments
                      ? `${story.comments} comment${story.comments === 1 ? "" : "s"}`
                      : "discuss"}
                  </a>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {!displayed.length && (
        <p className="empty">
          No stories on this page yet. <a href="/">Back to the front page</a>
        </p>
      )}
      {page < 5 && (
        <Link className="more" href={`/?feed=${feed}&page=${page + 1}`}>
          More
        </Link>
      )}
      <footer>
        <div className="footer-links">
          <a href={`${HN}/newsguidelines.html`}>Guidelines</a> |{" "}
          <a href={`${HN}/newsfaq.html`}>FAQ</a> |{" "}
          <a href={`${HN}/lists`}>Lists</a> |{" "}
          <a href="https://github.com/HackerNews/API">API</a> |{" "}
          <a href={`${HN}/security.html`}>Security</a> |{" "}
          <a href="https://www.ycombinator.com/legal/">Legal</a> |{" "}
          <a href="https://www.ycombinator.com/apply/">Apply to YC</a> |{" "}
          <a href="mailto:hn@ycombinator.com">Contact</a>
        </div>
        <form action="https://hn.algolia.com/" method="get">
          <label>
            Search: <input name="q" aria-label="Search Hacker News" />
          </label>
        </form>
        <p className="attribution">
          Hacker News, live with{" "}
          <a href="https://neon.com/docs/realtime">Neon Realtime</a>.
          Discussions and submissions happen on <a href={HN}>Hacker News</a>.
        </p>
      </footer>
    </main>
  );
}
