import { decodeTitle } from "./links";
export const TIMELINE_MS = 120_000;
export const TRANSITION_MS = 320;
export type HnEvent = {
  event_id: number;
  item_id: number;
  story_id: number;
  kind: string;
  label: string;
  details: string;
  occurred_at: number;
};
export function eventBuckets(events: readonly HnEvent[], now: number) {
  const buckets = new Map<number, HnEvent[]>();
  for (const event of events) {
    if (event.occurred_at < now - TIMELINE_MS || event.occurred_at > now)
      continue;
    const second = Math.floor(event.occurred_at / 1000) * 1000;
    const bucket = buckets.get(second) ?? [];
    bucket.push(event);
    buckets.set(second, bucket);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([time, rows]) => ({
      time,
      events: rows.sort((a, b) => a.event_id - b.event_id),
    }));
}
export function inViewport(
  rect: { top: number; bottom: number; left: number; right: number },
  width: number,
  bottom: number,
) {
  return (
    rect.bottom > 0 && rect.top < bottom && rect.right > 0 && rect.left < width
  );
}
export function eventDescription(event: HnEvent) {
  const kind = event.kind.replaceAll("-", " ");
  try {
    const details = JSON.parse(event.details);
    const fields = Object.entries(details).map(([field, value]) => {
      const name =
        field === "comments"
          ? "comment count"
          : field === "path"
            ? "position"
            : field;
      if (
        value &&
        typeof value === "object" &&
        "from" in value &&
        "to" in value
      )
        return `${name}: ${displayValue(field, value.from)} → ${displayValue(field, value.to)}`;
      return `${name}: ${displayValue(field, value)}`;
    });
    return [kind, ...fields].join(" · ");
  } catch {
    return kind;
  }
}
function displayValue(field: string, value: unknown) {
  if (value === null || value === undefined) return "none";
  const text = String(value);
  if (field === "text" || field === "body")
    return decodeTitle(text.replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  return decodeTitle(text);
}
