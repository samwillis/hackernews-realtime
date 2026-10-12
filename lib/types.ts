export type Feed = "top" | "new";
export const PAGE_SIZE = 30;
export const FEED_SIZE = 150;
export interface Story {
  item_id: number;
  rank: number;
  title: string;
  url: string | null;
  author: string | null;
  created: number;
  score: number;
  comments: number;
  type: string;
  committed_at: string;
  body?: string | null;
}
export interface SourceHealth {
  state: "starting" | "healthy" | "reconnecting" | "degraded" | "stopped";
  checkedAt: string | null;
  committedAt: string | null;
}
export function sortStories(rows: readonly Story[]): Story[] {
  return [...rows].sort((a, b) => a.rank - b.rank || a.item_id - b.item_id);
}
export function parseFeedPage(
  feed?: string | null,
  page?: string | null,
): { feed: Feed; page: number } {
  if (feed && feed !== "top" && feed !== "new") throw new Error("Invalid feed");
  if (page && !/^[1-5]$/.test(page))
    throw new Error("Page must be between 1 and 5");
  return {
    feed: feed === "new" ? "new" : "top",
    page: page ? Number(page) : 1,
  };
}
