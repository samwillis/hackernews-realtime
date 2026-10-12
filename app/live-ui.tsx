"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { createRealtimeClient } from "@neon/realtime/client";
import { RealtimeProvider } from "@neon/realtime-react";
import { HN } from "@/lib/links";
import type { Feed, SourceHealth } from "@/lib/types";
import type { ThreadHealth } from "@/lib/comments";
export function LiveProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() =>
    createRealtimeClient({ url: process.env.NEXT_PUBLIC_NEON_REALTIME_URL! }),
  );
  return <RealtimeProvider client={client}>{children}</RealtimeProvider>;
}
export function Header({
  feed,
  controls,
  connection,
  error,
}: {
  feed?: Feed;
  controls: Controls;
  connection: string;
  error?: string;
}) {
  return (
    <header className="hn-header">
      <Link href="/" className="logo" aria-label="Hacker Realtime home">
        RT
      </Link>
      <div className="header-content">
        <Link href="/" className="site-title">
          Hacker Realtime
        </Link>
        <nav aria-label="Main navigation">
          <Link href="/" className={feed === "top" ? "selected" : ""}>
            top
          </Link>
          <span> | </span>
          <Link href="/?feed=new" className={feed === "new" ? "selected" : ""}>
            new
          </Link>
          <span> | </span>
          <a href={`${HN}/submit`}>submit</a>
        </nav>
      </div>
      <LiveControls controls={controls} connection={connection} error={error} />
    </header>
  );
}
export function Footer() {
  return (
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
        <a href="https://neon.com/docs/realtime">Neon Realtime</a>. Replies and
        submissions happen on <a href={HN}>Hacker News</a>.
      </p>
    </footer>
  );
}
export function useLiveControls(
  initialNow: number,
  connection: string,
  healthUrl = "/api/health",
  healthMethod = "GET",
) {
  const [paused, setPaused] = useState(false);
  const [highlight, setHighlight] = useState(true);
  const [now, setNow] = useState(initialNow);
  const [health, setHealth] = useState<SourceHealth | ThreadHealth | null>(
    null,
  );
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10000);
    if (connection === "fixture") return () => clearInterval(tick);
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(healthUrl, {
          method: healthMethod,
          cache: "no-store",
        });
        const value = await response.json();
        if (!response.ok || !value.state)
          throw new Error("Source health unavailable");
        if (!disposed) setHealth(value);
      } catch {
        if (!disposed)
          setHealth({ state: "degraded", checkedAt: null, committedAt: null });
      }
    };
    void refresh();
    const check = setInterval(() => void refresh(), 10000);
    return () => {
      disposed = true;
      clearInterval(tick);
      clearInterval(check);
    };
  }, [connection === "fixture", healthUrl, healthMethod]);
  return { paused, setPaused, highlight, setHighlight, now, health };
}
export type Controls = ReturnType<typeof useLiveControls>;
export function LiveControls({
  controls,
  connection,
  error,
}: {
  controls: Controls;
  connection: string;
  error?: string;
}) {
  const { paused, setPaused, highlight, setHighlight, now, health } = controls;
  const fresh =
    health?.checkedAt &&
    now - Date.parse(health.checkedAt) < 30000 &&
    health.state === "healthy";
  return (
    <div className="live-controls">
      <button
        type="button"
        onClick={() => setPaused(!paused)}
        aria-pressed={paused}
        aria-label={paused ? "Resume live updates" : "Pause live updates"}
      >
        <span
          className={`live-dot ${paused ? "paused" : connection === "live" ? "on" : ""}`}
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
      <span role="status" title={error}>
        {connection === "fixture"
          ? "development fixture"
          : paused
            ? "paused"
            : connection === "live"
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
                : health.state === "busy"
                  ? "HN updates busy"
                  : health.state === "starting"
                    ? "HN loading…"
                    : health.state === "reconnecting"
                      ? "HN reconnecting…"
                      : "HN data may be stale"}
          </span>
        </>
      )}
    </div>
  );
}
