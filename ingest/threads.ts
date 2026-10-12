import { onValue, ref, type Database } from "@firebase/database";
import {
  selectComments,
  orderedComments,
  type ThreadSnapshot,
} from "./comment-tree";
export {
  selectComments,
  orderedComments,
  type ThreadSnapshot,
  type ThreadRow,
} from "./comment-tree";
import { readHn, mapLimit, type HnItem } from "./hn-api";

const normalize = (id: number, item: HnItem | null): HnItem =>
  item ? { ...item, id } : { id, deleted: true };

export class HnThread {
  private root?: HnItem;
  private items = new Map<number, HnItem>();
  private versions = new Map<number, number>();
  private rootVersion = 0;
  private revision = 0;
  private listeners = new Map<number, () => void>();
  private unsubscribe: () => void;
  private closed = false;
  private controller = new AbortController();
  private signal: AbortSignal;
  private reconciliation?: Promise<void>;
  private reconciledAt = 0;
  private receivedAt = 0;
  private attemptedAt = 0;
  failed = false;
  constructor(
    private db: Database,
    readonly id: number,
    signal: AbortSignal,
    private changed: () => void,
  ) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.unsubscribe = onValue(
      ref(db, `v0/item/${id}`),
      (value) => {
        if (this.closed) return;
        this.root = normalize(id, value.val());
        this.rootVersion = ++this.revision;
        this.receivedAt = Date.now();
        this.sync();
        this.changed();
      },
      () => {
        this.failed = true;
        this.changed();
      },
    );
    void this.reconcile().catch(() => {
      this.failed = true;
      this.changed();
    });
  }
  get ready() {
    return Boolean(
      this.root &&
        !this.failed &&
        this.reconciledAt &&
        selectComments(this.root, this.items).ids.every((id) =>
          this.items.has(id),
        ),
    );
  }
  invalidate() {
    this.reconciledAt = 0;
  }
  get needsReconcile() {
    return (
      !this.reconciliation &&
      (Date.now() - this.reconciledAt >= 60000 || this.failed) &&
      Date.now() - this.attemptedAt >= 5000
    );
  }
  private sync() {
    if (!this.root || this.closed) return;
    const selected = new Set(selectComments(this.root, this.items).ids);
    for (const [id, unsubscribe] of this.listeners)
      if (!selected.has(id)) {
        unsubscribe();
        this.listeners.delete(id);
        this.items.delete(id);
      }
    for (const id of selected)
      if (!this.listeners.has(id)) {
        this.listeners.set(id, () => {});
        this.listeners.set(
          id,
          onValue(
            ref(this.db, `v0/item/${id}`),
            (value) => {
              if (this.closed || !this.listeners.has(id)) return;
              this.items.set(id, normalize(id, value.val()));
              this.versions.set(id, ++this.revision);
              this.receivedAt = Date.now();
              this.sync();
              this.changed();
            },
            () => {
              this.failed = true;
              this.changed();
            },
          ),
        );
      }
  }
  copy(): ThreadSnapshot | null {
    if (!this.root || this.failed) return null;
    return {
      story: { ...this.root },
      rows: orderedComments(this.root, this.items),
      truncated: selectComments(this.root, this.items).truncated,
      receivedAt: this.receivedAt,
      complete: this.ready,
    };
  }
  async reconcile() {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.refresh().finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }
  private async refresh() {
    this.attemptedAt = Date.now();
    const version = this.revision;
    const root = normalize(
      this.id,
      await readHn<HnItem | null>(`item/${this.id}`, this.signal),
    );
    const refreshed = new Map<number, HnItem>();
    let pending = selectComments(root, refreshed).ids;
    while (pending.length) {
      const pairs = await mapLimit(
        pending,
        20,
        async (id) =>
          [
            id,
            normalize(
              id,
              await readHn<HnItem | null>(`item/${id}`, this.signal),
            ),
          ] as const,
      );
      pairs.forEach(([id, item]) => refreshed.set(id, item));
      pending = selectComments(root, refreshed).ids.filter(
        (id) => !refreshed.has(id),
      );
    }
    if (this.closed) return;
    if (this.rootVersion <= version) this.root = root;
    for (const [id, item] of refreshed)
      if ((this.versions.get(id) ?? 0) <= version) this.items.set(id, item);
    this.reconciledAt = Date.now();
    this.receivedAt = Date.now();
    this.failed = false;
    this.sync();
    this.changed();
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    this.unsubscribe();
    this.listeners.forEach((unsubscribe) => unsubscribe());
    await this.reconciliation?.catch(() => {});
  }
}
