export const THREAD_LIMIT = 500;
export const WATCH_SECONDS = 30;
export interface Comment {
  story_id: number;
  item_id: number;
  parent_id: number;
  path: string;
  depth: number;
  author: string | null;
  created: number;
  text: string;
  deleted: boolean;
  dead: boolean;
  committed_at: string;
}
export interface ThreadHealth {
  state: "starting" | "healthy" | "reconnecting" | "degraded";
  checkedAt: string | null;
  committedAt: string | null;
  truncated?: boolean;
}
export function sortComments(rows: readonly Comment[]): Comment[] {
  return [...rows].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.item_id - b.item_id,
  );
}
export function parseStoryId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,9}$/.test(value))
    throw new Error("Invalid story ID");
  const id = Number(value);
  if (id > 2147483647) throw new Error("Invalid story ID");
  return id;
}
export function discussionLink(id: number) {
  return `/item?id=${id}`;
}
