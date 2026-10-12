import { THREAD_LIMIT } from "../lib/comments";
import type { HnItem } from "./hn-api";

export interface ThreadRow {
  item: HnItem;
  parentId: number;
  path: string;
  depth: number;
}
export interface ThreadSnapshot {
  story: HnItem;
  rows: ThreadRow[];
  truncated: boolean;
  receivedAt: number;
  complete?: boolean;
}
const kids = (item?: HnItem) =>
  (item?.kids ?? []).filter((id) => Number.isInteger(id) && id > 0);

export function selectComments(
  root: HnItem,
  items: ReadonlyMap<number, HnItem>,
) {
  const queue: number[] = [];
  const queued = new Set<number>([root.id]);
  let truncated = (root.descendants ?? 0) > THREAD_LIMIT;
  const enqueue = (ids: number[]) => {
    for (const id of ids) {
      if (queued.has(id)) continue;
      if (queue.length >= THREAD_LIMIT) {
        truncated = true;
        break;
      }
      queued.add(id);
      queue.push(id);
    }
  };
  enqueue(kids(root));
  for (let i = 0; i < queue.length; i++) enqueue(kids(items.get(queue[i])));
  return { ids: queue, truncated };
}
export function orderedComments(
  root: HnItem,
  items: ReadonlyMap<number, HnItem>,
): ThreadRow[] {
  const selected = new Set(selectComments(root, items).ids);
  const seen = new Set<number>([root.id]);
  const rows: ThreadRow[] = [];
  const visit = (parent: HnItem, prefix: string, depth: number) => {
    kids(parent).forEach((id, index) => {
      const item = items.get(id);
      if (!item || !selected.has(id) || seen.has(id)) return;
      seen.add(id);
      const path = `${prefix}${String(index + 1).padStart(6, "0")}`;
      rows.push({ item, parentId: parent.id, path, depth });
      visit(item, `${path}.`, depth + 1);
    });
  };
  visit(root, "", 0);
  return rows;
}
