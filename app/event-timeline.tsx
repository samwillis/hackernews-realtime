"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { decodeTitle } from "@/lib/links";
import { useLiveQuery } from "@neon/realtime-react";
import type { SealedEvents } from "@/lib/queries";
import {
  eventBuckets,
  eventDescription,
  inViewport,
  TIMELINE_MS,
  TRANSITION_MS,
  type HnEvent,
} from "@/lib/events";
import { viewportBottom, VISIBILITY_EVENT } from "./timeline-visibility";
type Initial = { query: SealedEvents; events: HnEvent[] };
const emptyEvents: HnEvent[] = [];
export function EventTimeline({
  paused,
  fixtureEvents,
}: {
  paused: boolean;
  fixtureEvents?: readonly HnEvent[];
}) {
  const [initial, setInitial] = useState<Initial | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (fixtureEvents || initial) return;
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch("/api/events/live", { cache: "no-store" });
        if (!response.ok) throw new Error("Events unavailable");
        const value = await response.json();
        if (!disposed) {
          setInitial(value);
          setFailed(false);
        }
      } catch {
        if (!disposed) setFailed(true);
      }
    };
    void load();
    const retry = setInterval(() => void load(), 10000);
    return () => {
      disposed = true;
      clearInterval(retry);
    };
  }, [fixtureEvents, Boolean(initial)]);
  // Once subscribed, renewal belongs to the SDK; stop the initial fetch loop.
  if (fixtureEvents)
    return <Timeline events={fixtureEvents} paused={paused} status="fixture" />;
  if (initial) return <LiveTimeline initial={initial} paused={paused} />;
  return (
    <Timeline
      events={emptyEvents}
      paused={paused}
      status={failed ? "error" : "connecting"}
    />
  );
}
function LiveTimeline({
  initial,
  paused,
}: {
  initial: Initial;
  paused: boolean;
}) {
  const refreshQuery = useCallback(async () => {
    const response = await fetch("/api/events/live?capability=1", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Unable to renew live events");
    return (await response.json()).query as SealedEvents;
  }, []);
  const { data, status } = useLiveQuery(initial.query, {
    initialData: initial.events,
    refreshQuery,
  });
  return (
    <Timeline events={data ?? initial.events} paused={paused} status={status} />
  );
}
function useVisibleItems() {
  const [visible, setVisible] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    const grace = new Map<number, number>();
    let nodes: HTMLElement[] = [];
    const collect = () => {
      nodes = [
        ...document.querySelectorAll<HTMLElement>(".hn-page [data-item-id]"),
      ];
    };
    const sample = () => {
      const now = Date.now();
      const next = new Set<number>();
      const bottom = viewportBottom();
      for (const node of nodes)
        if (
          node.isConnected &&
          node.getClientRects().length &&
          inViewport(node.getBoundingClientRect(), window.innerWidth, bottom)
        )
          next.add(Number(node.dataset.itemId));
      for (const [id, until] of grace) {
        if (until > now) next.add(id);
        else grace.delete(id);
      }
      setVisible((old) =>
        old.size === next.size && [...next].every((id) => old.has(id))
          ? old
          : next,
      );
    };
    const transitions = (event: Event) => {
      for (const id of (event as CustomEvent<number[]>).detail)
        grace.set(id, Date.now() + TRANSITION_MS);
      sample();
    };
    collect();
    sample();
    const observer = new MutationObserver(() => {
      collect();
      sample();
    });
    const page = document.querySelector(".hn-page");
    if (page) observer.observe(page, { childList: true, subtree: true });
    window.addEventListener(VISIBILITY_EVENT, transitions);
    window.addEventListener("scroll", sample, { passive: true });
    window.addEventListener("resize", sample);
    const tick = setInterval(sample, 80);
    return () => {
      observer.disconnect();
      clearInterval(tick);
      window.removeEventListener(VISIBILITY_EVENT, transitions);
      window.removeEventListener("scroll", sample);
      window.removeEventListener("resize", sample);
    };
  }, []);
  return visible;
}
function Timeline({
  events,
  paused,
  status,
}: {
  events: readonly HnEvent[];
  paused: boolean;
  status: string;
}) {
  const [applied, setApplied] = useState(events);
  const [now, setNow] = useState(0);
  const [selected, setSelected] = useState<
    ReturnType<typeof eventBuckets>[number] | null
  >(null);
  const visible = useVisibleItems();
  const footer = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !footer.current?.contains(event.target)
      )
        setSelected(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [Boolean(selected)]);
  useEffect(() => {
    if (!paused) setApplied(events);
  }, [events, paused]);
  useEffect(() => {
    if (paused || selected) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    setNow(Date.now());
    const tick = setInterval(
      () => setNow(Date.now()),
      reduced.matches ? 1000 : 100,
    );
    return () => clearInterval(tick);
  }, [paused, Boolean(selected)]);
  const buckets = useMemo(() => eventBuckets(applied, now), [applied, now]);
  const count = buckets.reduce(
    (total, bucket) => total + bucket.events.length,
    0,
  );
  const close = () => setSelected(null);
  return (
    <footer
      ref={footer}
      className="event-timeline"
      aria-label="Live event timeline"
      onMouseLeave={() => {
        if (!footer.current?.contains(document.activeElement)) close();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          close();
          (document.activeElement as HTMLElement)?.blur();
        }
      }}
    >
      <div className="timeline-heading">
        <span>
          <strong>Realtime</strong>
          <span className="timeline-count"> · {count} events / 2 min</span>
        </span>
        <span className="timeline-legend">
          <span className="legend-dot on-screen" />
          in view <span className="legend-dot elsewhere" />
          elsewhere
        </span>
        <span className="timeline-status">
          {paused
            ? "paused"
            : selected
              ? "inspecting"
              : status === "error"
                ? "events disconnected"
                : status === "connecting" || status === "stale"
                  ? "connecting…"
                  : "hover or tap for details"}
        </span>
      </div>
      <div
        className="timeline-track"
        aria-label="Events from two minutes ago to now"
      >
        <div className="timeline-axis" />
        {[120, 90, 60, 30, 0].map((seconds) => (
          <span
            className="timeline-tick"
            key={seconds}
            style={{ left: `${(1 - seconds / 120) * 100}%` }}
          >
            {seconds === 0 ? "now" : `−${seconds}s`}
          </span>
        ))}
        {!count && (
          <span className="timeline-empty">
            {status === "error"
              ? "Reconnecting to events…"
              : "Waiting for changes…"}
          </span>
        )}
        {buckets.map((bucket) => {
          const onscreen = bucket.events.filter((event) =>
            visible.has(event.item_id),
          ).length;
          return (
            <button
              key={bucket.time}
              type="button"
              className={`timeline-bucket ${selected?.time === bucket.time ? "active" : ""}`}
              style={{
                left: `${Math.max(0, Math.min(100, 100 * (1 - (now - bucket.time) / TIMELINE_MS)))}%`,
              }}
              aria-label={`${bucket.events.length} ${bucket.events.length === 1 ? "event" : "events"}, ${onscreen} in view`}
              aria-expanded={selected?.time === bucket.time}
              aria-controls="timeline-details"
              data-event-count={bucket.events.length}
              data-visible-count={onscreen}
              onMouseEnter={() => setSelected(bucket)}
              onFocus={() => setSelected(bucket)}
              onClick={() => setSelected(bucket)}
            >
              <span className="bucket-dots">
                {onscreen > 0 && (
                  <span
                    className="event-stack on-screen"
                    style={{ height: `${Math.min(18, 4 + onscreen)}px` }}
                  />
                )}
                {onscreen < bucket.events.length && (
                  <span
                    className="event-stack elsewhere"
                    style={{
                      height: `${Math.min(18, 4 + bucket.events.length - onscreen)}px`,
                    }}
                  />
                )}
              </span>
              {bucket.events.length > 1 && (
                <span className="bucket-count">{bucket.events.length}</span>
              )}
            </button>
          );
        })}
      </div>
      {selected && (
        <section
          id="timeline-details"
          className="timeline-details"
          aria-label="Event details"
        >
          <div className="timeline-detail-heading">
            <strong>
              {selected.events.length}{" "}
              {selected.events.length === 1 ? "event" : "events"} ·{" "}
              {new Date(selected.time).toLocaleTimeString()}
            </strong>
            <button
              type="button"
              onClick={close}
              aria-label="Close event details"
            >
              ×
            </button>
          </div>
          <ul>
            {selected.events.map((event) => (
              <li
                key={event.event_id}
                data-event-id={event.event_id}
                className={visible.has(event.item_id) ? "event-in-view" : ""}
              >
                <span
                  className={`legend-dot ${visible.has(event.item_id) ? "on-screen" : "elsewhere"}`}
                />
                <div>
                  <Link
                    prefetch={false}
                    href={`/item?id=${event.story_id}${event.item_id !== event.story_id ? `#comment-${event.item_id}` : ""}`}
                  >
                    {decodeTitle(event.label)}
                  </Link>
                  <p>{eventDescription(event)}</p>
                  <span className="event-location">
                    {visible.has(event.item_id) ? "in view" : "elsewhere"} · #
                    {event.item_id}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </footer>
  );
}
