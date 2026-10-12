import { initializeApp, deleteApp, type FirebaseApp } from "@firebase/app";
import {
  getDatabase,
  onValue,
  ref,
  goOffline,
  type Database,
} from "@firebase/database";
import { FEED_SIZE, type Feed } from "../lib/types";
import { HnThread, type ThreadSnapshot } from "./threads";
export interface HnItem {
  id: number;
  type?: string;
  title?: string;
  url?: string;
  by?: string;
  time?: number;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
  kids?: number[];
  parent?: number;
  text?: string;
}
export interface SourceSnapshot {
  feeds: Record<Feed, number[]>;
  items: Map<number, HnItem>;
  revision: number;
  receivedAt: number;
  reconciledAt: number;
  itemReceipts?: Map<number, number>;
  feedReceipts?: Record<Feed, number>;
  threads?: ThreadSnapshot[];
}
const API = "https://hacker-news.firebaseio.com/v0";
export async function readHn<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API}/${path}.json`, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HN source returned ${response.status}`);
  return response.json() as Promise<T>;
}
export async function mapLimit<T, U>(
  values: T[],
  limit: number,
  fn: (value: T) => Promise<U>,
): Promise<U[]> {
  const result: U[] = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        result[index] = await fn(values[index]);
      }
    }),
  );
  return result;
}
const normalizeItem = (id: number, item: HnItem | null): HnItem =>
  item ? { ...item, id } : { id, deleted: true };

export class HnSource {
  private app: FirebaseApp;
  private db: Database;
  private listeners = new Map<number, () => void>();
  private initialized = new Set<number>();
  private unsubscribers: (() => void)[] = [];
  private closed = false;
  private reconnectEpoch = 0;
  private reconciledEpoch = -1;
  private reconciliation?: Promise<void>;
  private itemVersions = new Map<number, number>();
  private feedVersions: Record<Feed, number> = { top: 0, new: 0 };
  readonly threads = new Map<number, HnThread>();
  private closingThreads: Promise<void>[] = [];
  connected = false;
  failed = false;
  snapshot: SourceSnapshot = {
    feeds: { top: [], new: [] },
    items: new Map(),
    revision: 0,
    receivedAt: 0,
    reconciledAt: 0,
    itemReceipts: new Map(),
    feedReceipts: { top: 0, new: 0 },
  };
  constructor(
    owner: string,
    private signal: AbortSignal,
  ) {
    this.app = initializeApp(
      { databaseURL: "https://hacker-news.firebaseio.com" },
      owner,
    );
    this.db = getDatabase(this.app);
    const fail = () => {
      this.failed = true;
      this.connected = false;
    };
    this.unsubscribers.push(
      onValue(
        ref(this.db, ".info/connected"),
        (value) => {
          const wasConnected = this.connected;
          this.connected = value.val() === true;
          if (this.connected && !wasConnected) {
            this.reconnectEpoch++;
            this.failed = false;
            this.threads.forEach((thread) => thread.invalidate());
          }
        },
        fail,
      ),
    );
    for (const feed of ["top", "new"] as const) {
      this.unsubscribers.push(
        onValue(
          ref(this.db, `v0/${feed}stories`),
          (value) => {
            if (!Array.isArray(value.val())) {
              fail();
              return;
            }
            this.snapshot.feeds[feed] = value.val().slice(0, FEED_SIZE);
            this.markChanged();
            this.feedVersions[feed] = this.snapshot.revision;
            this.snapshot.feedReceipts![feed] = Date.now();
            this.syncListeners();
          },
          fail,
        ),
      );
    }
  }
  private markChanged() {
    this.snapshot.revision++;
    this.snapshot.receivedAt = Date.now();
  }
  private syncListeners() {
    const tracked = new Set([
      ...this.snapshot.feeds.top,
      ...this.snapshot.feeds.new,
    ]);
    for (const [id, unsubscribe] of this.listeners) {
      if (!tracked.has(id)) {
        unsubscribe();
        this.listeners.delete(id);
        this.initialized.delete(id);
        this.snapshot.items.delete(id);
      }
    }
    for (const id of tracked) {
      if (this.listeners.has(id)) continue;
      this.listeners.set(
        id,
        onValue(
          ref(this.db, `v0/item/${id}`),
          (value) => {
            this.snapshot.items.set(id, normalizeItem(id, value.val()));
            this.initialized.add(id);
            this.markChanged();
            this.itemVersions.set(id, this.snapshot.revision);
            this.snapshot.itemReceipts!.set(id, Date.now());
          },
          () => {
            this.failed = true;
          },
        ),
      );
    }
  }
  get ready() {
    const ids = [...this.snapshot.feeds.top, ...this.snapshot.feeds.new];
    return (
      this.connected &&
      !this.failed &&
      ids.length > 0 &&
      this.snapshot.reconciledAt > 0 &&
      ids.every((id) => this.initialized.has(id))
    );
  }
  get needsReconcile() {
    return (
      this.reconciledEpoch !== this.reconnectEpoch ||
      Date.now() - this.snapshot.reconciledAt >= 60000
    );
  }
  get prepared() {
    return (
      this.ready && [...this.threads.values()].every((thread) => thread.ready)
    );
  }
  watchThreads(ids: number[]) {
    if (this.closed) return;
    const wanted = new Set(ids);
    for (const [id, thread] of this.threads)
      if (!wanted.has(id)) {
        this.closingThreads.push(thread.close());
        this.threads.delete(id);
      }
    for (const id of wanted)
      if (!this.threads.has(id))
        this.threads.set(
          id,
          new HnThread(this.db, id, this.signal, () => this.markChanged()),
        );
    for (const thread of this.threads.values())
      if (thread.needsReconcile)
        void thread.reconcile().catch(() => {
          thread.failed = true;
        });
  }
  async reconcile() {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.refresh().finally(() => {
      this.reconciliation = undefined;
    });
    return this.reconciliation;
  }
  private async refresh() {
    const revision = this.snapshot.revision;
    const epoch = this.reconnectEpoch;
    const [top, fresh] = await Promise.all([
      readHn<number[]>("topstories", this.signal),
      readHn<number[]>("newstories", this.signal),
    ]);
    const feeds = {
      top: top.slice(0, FEED_SIZE),
      new: fresh.slice(0, FEED_SIZE),
    };
    const ids = [...new Set([...feeds.top, ...feeds.new])];
    const pairs = await mapLimit(
      ids,
      20,
      async (id) =>
        [
          id,
          normalizeItem(
            id,
            await readHn<HnItem | null>(`item/${id}`, this.signal),
          ),
        ] as const,
    );
    if (this.closed) return;
    // Preserve newer subscriptions independently for each node. Activity on one
    // item must not prevent authoritative recovery of a different missed item.
    for (const feed of ["top", "new"] as const) {
      if (this.feedVersions[feed] <= revision) {
        if (
          JSON.stringify(this.snapshot.feeds[feed]) !==
          JSON.stringify(feeds[feed])
        ) {
          this.snapshot.feeds[feed] = feeds[feed];
          this.snapshot.feedReceipts![feed] = Date.now();
          this.markChanged();
        }
      }
    }
    for (const [id, item] of pairs) {
      if (
        (this.itemVersions.get(id) ?? 0) <= revision &&
        JSON.stringify(this.snapshot.items.get(id)) !== JSON.stringify(item)
      ) {
        this.snapshot.items.set(id, item);
        this.snapshot.itemReceipts!.set(id, Date.now());
        this.markChanged();
      }
    }
    this.snapshot.reconciledAt = Date.now();
    this.reconciledEpoch = epoch;
    this.failed = false;
    this.syncListeners();
    await Promise.all(
      [...this.threads.values()].map((thread) =>
        thread.reconcile().catch(() => {
          thread.failed = true;
        }),
      ),
    );
  }
  copy(): SourceSnapshot {
    return {
      ...this.snapshot,
      feeds: {
        top: [...this.snapshot.feeds.top],
        new: [...this.snapshot.feeds.new],
      },
      items: new Map(this.snapshot.items),
      itemReceipts: new Map(this.snapshot.itemReceipts),
      feedReceipts: { ...this.snapshot.feedReceipts! },
      threads: [...this.threads.values()]
        .map((thread) => thread.copy())
        .filter((thread): thread is ThreadSnapshot => thread !== null),
    };
  }
  async close() {
    this.closed = true;
    this.unsubscribers.forEach((stop) => stop());
    this.listeners.forEach((stop) => stop());
    await Promise.all([
      ...this.closingThreads,
      ...[...this.threads.values()].map((thread) => thread.close()),
    ]);
    goOffline(this.db);
    await deleteApp(this.app);
  }
}
