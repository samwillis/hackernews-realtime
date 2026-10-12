import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  LiveQuerySnapshot,
  RealtimeClient,
  SealedLiveQuery,
} from "@neon/realtime/client";
import { LiveQueryCache } from "../lib/live-cache";
import { liveRoute, NavigationIntent } from "../lib/live-route";

const query = (key: string): SealedLiveQuery<number> => ({
  capability: `${Buffer.from(JSON.stringify({ alg: "dir", enc: "A256GCM", v: 1 })).toString("base64url")}..iv.ciphertext.tag`,
  queryFingerprint: createHash("sha256").update(key).digest("hex"),
  expiresAt: Date.now() + 60000,
});
function mockClient() {
  const handles: {
    emit: (snapshot: LiveQuerySnapshot<number>) => void;
    closed: boolean;
    renewals: SealedLiveQuery<number>[];
  }[] = [];
  const client = {
    subscribe(_query: unknown, options: { initialData?: number[] }) {
      let snapshot: LiveQuerySnapshot<number> = {
        status: "stale",
        error: undefined,
        data: options.initialData,
      };
      const listeners = new Set<
        (snapshot: LiveQuerySnapshot<number>) => void
      >();
      const handle = {
        closed: false,
        renewals: [] as SealedLiveQuery<number>[],
        emit(next: LiveQuerySnapshot<number>) {
          snapshot = next;
          listeners.forEach((listener) => listener(snapshot));
        },
      };
      handles.push(handle);
      return {
        getSnapshot: () => snapshot,
        onChange(listener: (snapshot: LiveQuerySnapshot<number>) => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        renew: async (query: SealedLiveQuery<number>) => {
          handle.renewals.push(query);
        },
        unsubscribe() {
          handle.closed = true;
          handle.emit({ ...snapshot, status: "closed", error: undefined });
          listeners.clear();
        },
      };
    },
    close() {},
  } as unknown as RealtimeClient;
  return { client, handles };
}
const live = (data: number[]): LiveQuerySnapshot<number> => ({
  status: "live",
  error: undefined,
  data,
});

test("route preparation waits for live reset and page mount reuses the handle and current rows", async () => {
  const { client, handles } = mockClient();
  const cache = new LiveQueryCache(client);
  try {
    const sealed = query("top");
    const prepared = cache.get("feed:top:1", sealed, [1], async () => sealed);
    let ready = false;
    const pending = prepared.ready().then(() => {
      ready = true;
    });
    await Promise.resolve();
    assert.equal(
      ready,
      false,
      "SSR fallback is not an authoritative live baseline",
    );
    assert.equal(prepared.getSnapshot().status, "connecting");
    handles[0].emit(live([2]));
    await pending;
    const mounted = cache.get(
      "feed:top:1",
      { ...sealed, capability: "new capability" },
      [0],
      async () => sealed,
    );
    const unsubscribe = mounted.subscribe(() => {});
    assert.equal(mounted, prepared);
    assert.equal(handles.length, 1);
    assert.deepEqual(mounted.getSnapshot().data, [2]);
    handles[0].emit({ status: "stale", error: undefined, data: [2] });
    assert.equal(
      mounted.getSnapshot().status,
      "stale",
      "a real reconnect is visible after the baseline",
    );
    unsubscribe();
  } finally {
    cache.close();
  }
});

test("warm back navigation survives unmount, idle entries expire, active entries survive", async () => {
  const { client, handles } = mockClient();
  const cache = new LiveQueryCache(client, 35);
  try {
    const sealed = query("top");
    const store = cache.get("top", sealed, [], async () => sealed);
    const release = store.subscribe(() => {});
    handles[0].emit(live([1]));
    release();
    assert.equal(cache.find("top"), store);
    const releaseAgain = store.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(handles[0].closed, false);
    releaseAgain();
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(handles[0].closed, true);
    assert.equal(cache.find("top"), undefined);
  } finally {
    cache.close();
  }
});

test("idle cache is bounded without evicting an active page", () => {
  const { client, handles } = mockClient();
  const cache = new LiveQueryCache(client, 60000, 2);
  try {
    const q = query("active");
    cache.get("active", q, [], async () => q).subscribe(() => {});
    for (const key of ["one", "two", "three"]) {
      const sealed = query(key);
      cache.get(key, sealed, [], async () => sealed).start();
    }
    assert.equal(handles[0].closed, false);
    assert.equal(handles[1].closed, true);
    assert.equal(cache.find("one"), undefined);
    assert.ok(cache.find("three"));
    assert.throws(
      () => cache.get("active", query("different"), [], async () => q),
      /identity changed/,
    );
  } finally {
    cache.close();
  }
});

test("failed or slow preparation settles so navigation can fall back to SSR", async () => {
  const { client, handles } = mockClient();
  const cache = new LiveQueryCache(client);
  try {
    const sealed = query("slow");
    const slow = cache.get("slow", sealed, [], async () => sealed);
    await assert.rejects(slow.ready(10), /timed out/);
    const error = Object.assign(new Error("Offline"), {
      code: "offline",
      retryable: false,
    });
    const pending = slow.ready();
    handles[0].emit({ status: "error", error, data: [] });
    await assert.rejects(pending, /Offline/);
    assert.equal(slow.getSnapshot().status, "error");
    assert.equal(cache.find("slow"), undefined);
  } finally {
    cache.close();
  }
});

test("cached subscriptions renew capabilities and invalid renewal stays visibly failed", async () => {
  const { client, handles } = mockClient();
  const cache = new LiveQueryCache(client);
  try {
    const sealed = { ...query("renew"), expiresAt: Date.now() + 9990 };
    const replacement = query("renew");
    const store = cache.get("renew", sealed, [1], async () => replacement);
    const release = store.subscribe(() => {});
    handles[0].emit(live([2]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(handles[0].renewals, [replacement]);
    assert.deepEqual(store.getSnapshot().data, [2]);
    release();

    const invalid = { ...query("invalid"), expiresAt: Date.now() + 9990 };
    const failed = cache.get("invalid", invalid, [1], async () =>
      query("wrong identity"),
    );
    const pending = failed.ready();
    await assert.rejects(pending, /Unable to renew/);
    handles[1].emit(live([3]));
    assert.equal(
      failed.getSnapshot().status,
      "error",
      "a row update cannot hide a renewal failure",
    );
    assert.deepEqual(handles[1].renewals, []);
  } finally {
    cache.close();
  }
});

test("route identity ignores comment anchors and rapid navigation only commits the latest choice", () => {
  assert.deepEqual(liveRoute("/?feed=new&page=2"), {
    kind: "feed",
    key: "feed:new:2",
    api: "/api/feed/live?feed=new&page=2",
  });
  assert.equal(liveRoute("/item?id=123#comment-456")?.key, "thread:123");
  assert.equal(liveRoute("https://news.ycombinator.com/item?id=123"), null);
  assert.equal(liveRoute("//example.com"), null);
  assert.throws(() => liveRoute("/item?id=-1"));
  const intent = new NavigationIntent();
  const first = intent.begin();
  const second = intent.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  intent.cancel();
  assert.equal(second(), false, "browser back cancels a pending click");
});
