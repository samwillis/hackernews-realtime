"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { markTransitionVisible, rectVisible } from "./timeline-visibility";
import {
  rowChanges,
  HIGHLIGHT_MS,
  type IdentifiedRow,
  type RowChange,
} from "@/lib/changes";
type Position = {
  top: number;
  height: number;
  padding: string;
  visible: boolean;
};
export function useLiveList<T extends IdentifiedRow>(
  initialRows: readonly T[],
  incoming: readonly T[],
  sort: (rows: readonly T[]) => T[],
  fields: readonly (keyof T & string)[],
  paused: boolean,
  highlight: boolean,
  initialNow: number,
) {
  const [state, setState] = useState(() => ({
    rows: sort(initialRows),
    changes: new Map<number, RowChange>(),
    appliedAt: initialNow,
  }));
  const prior = useRef(state.rows);
  const changes = useRef(state.changes);
  const nodes = useRef(new Map<number, HTMLElement>());
  const layoutAnimations = useRef(new Set<Animation>());
  const colorAnimations = useRef(new Set<Animation>());
  const lastColor = useRef(new Map<number, number>());
  const wasPaused = useRef(false);
  const pending = useRef<{
    before: Map<number, Position>;
    entering: Set<number>;
    animate: boolean;
  } | null>(null);
  const cancelLayout = () => {
    layoutAnimations.current.forEach((animation) => animation.cancel());
    layoutAnimations.current.clear();
  };
  useEffect(() => {
    if (paused) {
      wasPaused.current = true;
      cancelLayout();
      colorAnimations.current.forEach((animation) => animation.cancel());
      colorAnimations.current.clear();
      changes.current = new Map();
      setState((current) => ({ ...current, changes: new Map() }));
      return;
    }
    const rows = sort(incoming);
    const resuming = wasPaused.current;
    wasPaused.current = false;
    const animate = highlight && !resuming;
    if (!animate) {
      colorAnimations.current.forEach((animation) => animation.cancel());
      colorAnimations.current.clear();
    }
    const before = new Map<number, Position>();
    for (const [id, node] of nodes.current)
      if (node.getClientRects().length) {
        const rect = node.getBoundingClientRect();
        before.set(id, {
          top: rect.top + window.scrollY,
          height: rect.height,
          padding: getComputedStyle(node).paddingBottom,
          visible: rectVisible(rect),
        });
      }
    cancelLayout();
    const nextIndex = new Map(rows.map((row, index) => [row.item_id, index]));
    markTransitionVisible(
      prior.current
        .filter((row, index) => {
          return (
            nextIndex.get(row.item_id) !== index &&
            before.get(row.item_id)?.visible
          );
        })
        .map((row) => row.item_id),
    );
    const now = Date.now();
    const updated = animate
      ? rowChanges(prior.current, rows, fields, changes.current, now)
      : new Map<number, RowChange>();
    const oldIds = new Set(prior.current.map((row) => row.item_id));
    pending.current = {
      before,
      animate,
      entering: new Set(
        rows
          .filter((row) => !oldIds.has(row.item_id))
          .map((row) => row.item_id),
      ),
    };
    if (process.env.NEXT_PUBLIC_MEASURE_REALTIME === "1" && !resuming) {
      const old = new Map(prior.current.map((row) => [row.item_id, row]));
      for (const row of rows) {
        const oldRow = old.get(row.item_id) as
          | (T & { committed_at?: string })
          | undefined;
        const current = row as T & { committed_at?: string };
        if (
          oldRow &&
          current.committed_at &&
          oldRow.committed_at !== current.committed_at
        )
          console.debug(
            "hn_realtime_applied",
            JSON.stringify({
              id: row.item_id,
              committedAt: current.committed_at,
              appliedAt: now,
              latencyMs: now - Date.parse(current.committed_at),
            }),
          );
      }
    }
    prior.current = rows;
    changes.current = updated;
    setState({ rows, changes: updated, appliedAt: now });
  }, [incoming, paused, highlight, sort, fields]);
  useEffect(() => {
    if (!state.changes.size) return;
    const stamps = [...state.changes.values()].flatMap((change) =>
      [change.entered, change.moved, ...Object.values(change.fields)].filter(
        (stamp): stamp is number => stamp !== undefined,
      ),
    );
    const timeout = setTimeout(
      () => {
        setState((current) => {
          const remaining = rowChanges(
            current.rows,
            current.rows,
            [],
            current.changes,
            Date.now(),
          );
          changes.current = remaining;
          return { ...current, changes: remaining };
        });
      },
      Math.max(1, Math.min(...stamps) + HIGHLIGHT_MS - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [state.changes]);
  useLayoutEffect(() => {
    const update = pending.current;
    pending.current = null;
    if (update) {
      const crossing: number[] = [];
      for (const [id, node] of nodes.current) {
        const full = node.getBoundingClientRect();
        const old = update.before.get(id);
        if (
          update.entering.has(id) ||
          (old &&
            (Math.abs(old.top - window.scrollY - full.top) > 0.5 ||
              Math.abs(old.height - full.height) > 0.5))
        ) {
          const top = Math.min(
            full.top,
            old ? old.top - window.scrollY : full.top,
          );
          const bottom = Math.max(
            full.bottom,
            old ? old.top - window.scrollY + old.height : full.bottom,
          );
          if (rectVisible({ top, bottom, left: full.left, right: full.right }))
            crossing.push(id);
        }
      }
      markTransitionVisible(crossing);
    }
    if (
      !update?.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const animate = (node: HTMLElement, frames: Keyframe[]) => {
      const animation = node.animate(frames, {
        duration: 320,
        easing: "cubic-bezier(.2,.7,.2,1)",
        fill: "both",
      });
      animation.currentTime = 0;
      layoutAnimations.current.add(animation);
      void animation.finished.then(
        () => {
          animation.cancel();
          layoutAnimations.current.delete(animation);
        },
        () => {},
      );
    };
    // Collapse entering rows before measuring destinations. Their expansion then
    // moves neighbours naturally; FLIP only accounts for the remaining reorder.
    for (const [id, node] of nodes.current)
      if (node.getClientRects().length) {
        const full = node.getBoundingClientRect();
        const old = update.before.get(id);
        if (
          update.entering.has(id) ||
          (old && Math.abs(old.height - full.height) > 0.5)
        )
          animate(node, [
            {
              height: `${old?.height ?? 0}px`,
              paddingBottom: old?.padding ?? "0px",
              opacity: old ? 1 : 0,
              overflow: "hidden",
            },
            {
              height: `${full.height}px`,
              paddingBottom: getComputedStyle(node).paddingBottom,
              opacity: 1,
              overflow: "hidden",
            },
          ]);
      }
    for (const [id, node] of nodes.current)
      if (node.getClientRects().length) {
        const old = update.before.get(id);
        if (!old) continue;
        const delta =
          old.top - (node.getBoundingClientRect().top + window.scrollY);
        if (Math.abs(delta) > 0.5)
          animate(node, [
            { transform: `translateY(${delta}px)` },
            { transform: "translateY(0)" },
          ]);
      }
  }, [state.rows]);
  useLayoutEffect(() => {
    if (!highlight) {
      colorAnimations.current.forEach((animation) => animation.cancel());
      colorAnimations.current.clear();
      return;
    }
    for (const [id, change] of state.changes) {
      const stamp = Math.max(change.entered ?? 0, change.moved ?? 0);
      const node = nodes.current.get(id);
      if (!stamp || !node || lastColor.current.get(id) === stamp) continue;
      lastColor.current.set(id, stamp);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        continue;
      const animation = node.animate(
        [{ backgroundColor: "#ffe6b3" }, { backgroundColor: "transparent" }],
        { duration: HIGHLIGHT_MS },
      );
      colorAnimations.current.add(animation);
      void animation.finished.then(
        () => colorAnimations.current.delete(animation),
        () => {},
      );
    }
    for (const id of lastColor.current.keys())
      if (!nodes.current.has(id)) lastColor.current.delete(id);
  }, [state.changes, highlight]);
  useEffect(
    () => () => {
      layoutAnimations.current.forEach((animation) => animation.cancel());
      colorAnimations.current.forEach((animation) => animation.cancel());
    },
    [],
  );
  return {
    ...state,
    register: (id: number, node: HTMLElement | null) => {
      if (node) nodes.current.set(id, node);
      else nodes.current.delete(id);
    },
  };
}
