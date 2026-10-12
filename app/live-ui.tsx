"use client";
import { useEffect, useState } from "react";
import { LiveLink as Link } from "./live-link";
import { useConnection, useSession, useSettings } from "./live-session";
import { HN } from "@/lib/links";
import type { Feed, SourceHealth } from "@/lib/types";
import type { ThreadHealth } from "@/lib/comments";
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
  const sharedConnection = useConnection(connection);
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
      <LiveControls
        controls={controls}
        connection={sharedConnection}
        error={error}
      />
    </header>
  );
}
export function useLiveControls(
  initialNow: number,
  connection: string,
  healthUrl = "/api/health",
  healthMethod = "GET",
) {
  const settings = useSettings();
  const session = useSession();
  const [health, setHealth] = useState<SourceHealth | ThreadHealth | null>(
    () => session.threadHealth.get(healthUrl) ?? null,
  );
  useEffect(() => {
    if (connection === "fixture" || healthUrl === "/api/health") return;
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
        session.threadHealth.set(healthUrl, value);
        // Health caching does not keep the ingestion watch alive after leaving.
        if (session.threadHealth.size > 8)
          session.threadHealth.delete(
            session.threadHealth.keys().next().value!,
          );
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
      clearInterval(check);
    };
  }, [connection === "fixture", healthUrl, healthMethod, session]);
  return {
    ...settings,
    now: settings.now || initialNow,
    health: healthUrl === "/api/health" ? settings.health : health,
    sourceHealth: settings.health,
  };
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
  const {
    paused,
    setPaused,
    highlight,
    setHighlight,
    now,
    sourceHealth: health,
  } = controls;
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
