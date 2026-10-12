import { inViewport } from "@/lib/events";
export const VISIBILITY_EVENT = "hn:transition-visible";
export function viewportBottom() {
  return (
    document.querySelector(".event-timeline")?.getBoundingClientRect().top ??
    window.innerHeight
  );
}
export function markTransitionVisible(ids: number[]) {
  if (ids.length)
    window.dispatchEvent(new CustomEvent(VISIBILITY_EVENT, { detail: ids }));
}
export function rectVisible(rect: {
  top: number;
  bottom: number;
  left: number;
  right: number;
}) {
  return inViewport(rect, window.innerWidth, viewportBottom());
}
