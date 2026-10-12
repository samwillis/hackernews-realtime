import {
  QueryRefreshController,
  type LiveQueryError,
  type LiveQuerySnapshot,
  type MaterializedLiveQuerySubscription,
  type RealtimeClient,
  type SealedLiveQuery,
} from "@neon/realtime/client";

export class LiveStore<Row> {
  private subscription?: MaterializedLiveQuerySubscription<Row>;
  private refresh?: QueryRefreshController<Row>;
  private detach?: () => void;
  private expiry?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private waiters = new Set<() => void>();
  private snapshot: LiveQuerySnapshot<Row>;
  private disposed = false;
  private baseline = false;
  private refreshError?: LiveQueryError;
  lastUsed = Date.now();

  constructor(
    private client: RealtimeClient,
    readonly query: SealedLiveQuery<Row>,
    initialData: readonly Row[] | undefined,
    private refreshQuery: () => Promise<SealedLiveQuery<Row>>,
    private idleMs: number,
    private onIdle: () => void,
    private onWarm: () => void,
  ) {
    this.snapshot = {
      status: "connecting",
      error: undefined,
      data: initialData,
    };
  }

  get active() {
    return this.listeners.size > 0;
  }
  get failed() {
    return this.snapshot.status === "error" || this.disposed;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.active) this.keepWarm();
    };
  };

  start() {
    if (this.disposed) throw new Error("Live query has been disposed");
    this.lastUsed = Date.now();
    clearTimeout(this.expiry);
    if (!this.subscription) {
      const subscription = this.client.subscribe(this.query, {
        initialData: this.snapshot.data,
      });
      this.subscription = subscription;
      this.publish(subscription.getSnapshot());
      this.detach = subscription.onChange((snapshot) => this.publish(snapshot));
      this.refresh = new QueryRefreshController({
        query: this.query,
        subscription,
        refreshQuery: this.refreshQuery,
        renewSubscription: (query) => subscription.renew(query),
        onSubscriptionRenewed: () => {
          this.refreshError = undefined;
          this.publish(subscription.getSnapshot());
        },
        onRefreshExhausted: () => {
          const error = Object.assign(
            new Error("Unable to renew the live query"),
            {
              code: "QUERY_REFRESH_FAILED",
              retryable: false,
            },
          ) satisfies LiveQueryError;
          this.refreshError = error;
          this.publish(subscription.getSnapshot());
        },
      });
      this.refresh.start();
    }
    if (!this.active) this.keepWarm();
  }

  // Initial rows are only a fallback. Navigation waits for the authoritative reset.
  ready(timeout = 5000): Promise<void> {
    this.start();
    if (this.snapshot.status === "live") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const check = () => {
        const { status, error } = this.snapshot;
        if (status !== "live" && status !== "error" && status !== "closed")
          return;
        clearTimeout(timer);
        detach();
        if (status === "live") resolve();
        else reject(error ?? new Error("Live query closed"));
      };
      const detach = () => {
        this.waiters.delete(check);
      };
      const timer = setTimeout(() => {
        detach();
        reject(new Error("Live query preparation timed out"));
      }, timeout);
      this.waiters.add(check);
      check();
    });
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.expiry);
    this.refresh?.stop();
    this.detach?.();
    this.subscription?.unsubscribe();
    this.snapshot = { ...this.snapshot, status: "closed", error: undefined };
    this.listeners.forEach((listener) => listener());
    this.waiters.forEach((listener) => listener());
  }

  private publish(snapshot: LiveQuerySnapshot<Row>) {
    if (snapshot.status === "live") this.baseline = true;
    this.snapshot =
      snapshot.status === "stale" && !this.baseline
        ? { ...snapshot, status: "connecting" }
        : snapshot;
    if (this.refreshError)
      this.snapshot = {
        ...this.snapshot,
        status: "error",
        error: this.refreshError,
      };
    this.listeners.forEach((listener) => listener());
    this.waiters.forEach((listener) => listener());
  }
  private keepWarm() {
    clearTimeout(this.expiry);
    this.lastUsed = Date.now();
    this.expiry = setTimeout(this.onIdle, this.idleMs);
    this.onWarm();
  }
}

// One cache per layout. Prepared and mounted queries consume the same SDK handle.
export class LiveQueryCache {
  private entries = new Map<string, LiveStore<unknown>>();
  constructor(
    private client: RealtimeClient,
    private idleMs = 60000,
    private maxIdle = 8,
  ) {}

  find(key: string) {
    const store = this.entries.get(key);
    return store && !store.failed ? store : undefined;
  }

  get<Row>(
    key: string,
    query: SealedLiveQuery<Row>,
    initialData: readonly Row[] | undefined,
    refreshQuery: () => Promise<SealedLiveQuery<Row>>,
  ) {
    const old = this.entries.get(key);
    if (old && old.query.queryFingerprint !== query.queryFingerprint)
      throw new Error("Live query cache identity changed");
    if (old && !old.failed) return old as LiveStore<Row>;
    old?.dispose();
    const store = new LiveStore(
      this.client,
      query,
      initialData,
      refreshQuery,
      this.idleMs,
      () => {
        if (!store.active) {
          store.dispose();
          this.entries.delete(key);
        }
      },
      () => this.trim(key),
    );
    this.entries.set(key, store as LiveStore<unknown>);
    this.trim(key);
    return store;
  }

  close() {
    this.entries.forEach((store) => store.dispose());
    this.entries.clear();
  }
  private trim(protectedKey: string) {
    const idle = [...this.entries]
      .filter(([key, store]) => key !== protectedKey && !store.active)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (idle.length >= this.maxIdle) {
      const [key, store] = idle.shift()!;
      store.dispose();
      this.entries.delete(key);
    }
  }
}
