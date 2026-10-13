"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createRealtimeClient,
  type SealedLiveQuery,
  type RealtimeLogEntry,
} from "@neon/realtime/client";
import { RealtimeProvider } from "@neon/realtime-react";
import { LiveQueryCache } from "@/lib/live-cache";
import { liveRoute, NavigationIntent } from "@/lib/live-route";
import type { Story, SourceHealth } from "@/lib/types";
import type { Comment, ThreadHealth } from "@/lib/comments";
import type { SealedFeed, SealedComments, SealedStory } from "@/lib/queries";
import { EventTimeline } from "./event-timeline";

type Connection = "connecting" | "live" | "stale" | "error";
class Session {
  constructor(private fixture: boolean) {}
  private connection: Connection = "connecting";
  private listeners = new Set<() => void>();
  private requests = new Map<string, Promise<unknown>>();
  private preparations = new Map<string, Promise<void>>();
  readonly navigation = new NavigationIntent();
  readonly threadHealth = new Map<string, ThreadHealth>();
  private client = createRealtimeClient({
    url: process.env.NEXT_PUBLIC_NEON_REALTIME_URL!,
    logLevel: "info",
    logger: (entry: RealtimeLogEntry) => {
      let next: Connection | undefined;
      if (
        entry.event === "connection_ready" ||
        entry.event === "connection_recovered"
      )
        next = "live";
      if (entry.event === "connection_lost") next = "stale";
      if (
        entry.event === "connection_failed" ||
        entry.event === "connection_reconnect_exhausted"
      )
        next = "error";
      if (next && next !== this.connection) {
        this.connection = next;
        this.listeners.forEach((listener) => listener());
      }
    },
  });
  readonly cache = new LiveQueryCache(this.client);
  getClient() {
    return this.client;
  }
  getConnection = () => this.connection;
  getServerConnection = () => "connecting" as const;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  closeTimer?: ReturnType<typeof setTimeout>;
  close() {
    this.cache.close();
    this.client.close();
  }

  // Capabilities stay in memory, and concurrent renewals for a thread share a request.
  json<T>(url: string): Promise<T> {
    const existing = this.requests.get(url);
    if (existing) return existing as Promise<T>;
    const request = fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(url.includes("load=1") ? 10000 : 6000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Unable to prepare live updates");
      return response.json() as Promise<T>;
    });
    this.requests.set(url, request);
    void request.finally(() => this.requests.delete(url)).catch(() => {});
    return request;
  }

  prepare(href: string): Promise<void> {
    if (this.fixture) return Promise.resolve();
    const route = liveRoute(href);
    if (!route) return Promise.resolve();
    const existing = this.preparations.get(route.key);
    if (existing) return existing;
    const preparation = (async () => {
      if (route.kind === "feed") {
        const warm = this.cache.find(route.key);
        if (warm) return warm.ready();
        const renew = () => this.json<SealedFeed>(route.api);
        const query = await renew();
        await this.cache.get<Story>(route.key, query, undefined, renew).ready();
      } else {
        const warmStory = this.cache.find(`story:${route.id}`);
        const warmComments = this.cache.find(`comments:${route.id}`);
        if (warmStory && warmComments) {
          await Promise.all([warmStory.ready(), warmComments.ready()]);
          return;
        }
        type Queries = { story: SealedStory; comments: SealedComments };
        const renew = () => this.json<Queries>(route.api);
        const query = await this.json<Queries>(`${route.api}&load=1`);
        await Promise.all([
          this.cache
            .get<Story>(
              `story:${route.id}`,
              query.story,
              undefined,
              async () => (await renew()).story,
            )
            .ready(),
          this.cache
            .get<Comment>(
              `comments:${route.id}`,
              query.comments,
              undefined,
              async () => (await renew()).comments,
            )
            .ready(),
        ]);
      }
    })();
    this.preparations.set(route.key, preparation);
    void preparation
      .finally(() => this.preparations.delete(route.key))
      .catch(() => {});
    return preparation;
  }
}

const SessionContext = createContext<Session | null>(null);
type Settings = {
  paused: boolean;
  highlight: boolean;
  now: number;
  health: SourceHealth | null;
};
const SettingsContext = createContext<Settings | null>(null);
export function LiveProvider({
  children,
  fixture = false,
}: {
  children: ReactNode;
  fixture?: boolean;
}) {
  const [session] = useState(() => new Session(fixture));
  const [now, setNow] = useState(0);
  const [health, setHealth] = useState<SourceHealth | null>(null);
  useEffect(() => {
    clearTimeout(session.closeTimer);
    const cancel = () => session.navigation.cancel();
    window.addEventListener("popstate", cancel);
    return () => {
      window.removeEventListener("popstate", cancel);
      session.closeTimer = setTimeout(() => session.close(), 0);
    };
  }, [session]);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      setNow(Date.now());
      if (fixture) return;
      try {
        const value = await session.json<SourceHealth>("/api/health");
        if (!value.state) throw new Error("Source health unavailable");
        if (!disposed) setHealth(value);
      } catch {
        if (!disposed)
          setHealth({ state: "degraded", checkedAt: null, committedAt: null });
      }
    };
    void refresh();
    const tick = setInterval(() => void refresh(), 10000);
    return () => {
      disposed = true;
      clearInterval(tick);
    };
  }, [session, fixture]);
  const settings = useMemo(
    () => ({ paused: false, highlight: true, now, health }),
    [now, health],
  );
  return (
    <SessionContext.Provider value={session}>
      <SettingsContext.Provider value={settings}>
        <RealtimeProvider client={session.getClient()}>
          <div id="route-content">{children}</div>
          {!fixture && <EventTimeline paused={false} />}
        </RealtimeProvider>
      </SettingsContext.Provider>
    </SessionContext.Provider>
  );
}
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Missing shared Realtime session");
  return session;
}
export function useSettings() {
  const settings = useContext(SettingsContext);
  if (!settings) throw new Error("Missing live settings");
  return settings;
}
export function useConnection(queryStatus: string) {
  const session = useSession();
  const connection = useSyncExternalStore(
    session.subscribe,
    session.getConnection,
    session.getServerConnection,
  );
  return queryStatus === "fixture"
    ? "fixture"
    : queryStatus === "error"
      ? "error"
      : connection === "live" && queryStatus === "stale"
        ? "stale"
        : connection;
}
export function useCachedLiveQuery<Row>(
  key: string,
  query: SealedLiveQuery<Row>,
  initialData: readonly Row[],
  refreshQuery: () => Promise<SealedLiveQuery<Row>>,
) {
  const { cache } = useSession();
  const store = useMemo(
    () => cache.get(key, query, initialData, refreshQuery),
    [cache, key, query, initialData, refreshQuery],
  );
  const serverSnapshot = useMemo(
    () => ({
      status: "connecting" as const,
      error: undefined,
      data: initialData,
    }),
    [initialData],
  );
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => serverSnapshot,
  );
}
