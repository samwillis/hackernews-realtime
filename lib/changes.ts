export interface IdentifiedRow {
  item_id: number;
}
export interface RowChange {
  entered?: number;
  moved?: number;
  fields: Record<string, number>;
}
export const HIGHLIGHT_MS = 1800;

// Preserve independent field highlights when another update arrives mid-pulse.
export function rowChanges<T extends IdentifiedRow>(
  before: readonly T[],
  after: readonly T[],
  fields: readonly (keyof T & string)[],
  previous: ReadonlyMap<number, RowChange>,
  now: number,
): Map<number, RowChange> {
  const old = new Map(
    before.map((row, index) => [row.item_id, { row, index }]),
  );
  const next = new Map<number, RowChange>();
  after.forEach((row, index) => {
    const prior = old.get(row.item_id);
    const retained = previous.get(row.item_id);
    const change: RowChange = {
      fields: Object.fromEntries(
        Object.entries(retained?.fields ?? {}).filter(
          ([, at]) => now - at < HIGHLIGHT_MS,
        ),
      ),
      entered:
        retained?.entered && now - retained.entered < HIGHLIGHT_MS
          ? retained.entered
          : undefined,
      moved:
        retained?.moved && now - retained.moved < HIGHLIGHT_MS
          ? retained.moved
          : undefined,
    };
    if (!prior) change.entered = now;
    else {
      if (prior.index !== index) change.moved = now;
      for (const field of fields)
        if (prior.row[field] !== row[field]) change.fields[field] = now;
    }
    if (change.entered || change.moved || Object.keys(change.fields).length)
      next.set(row.item_id, change);
  });
  return next;
}
