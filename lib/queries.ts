import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { createRealtime } from "@neon/realtime/server";
import { drizzleAdapter } from "@neon/realtime-drizzle";
import { database } from "./db";
import { entries, items } from "./schema";
import { PAGE_SIZE, type Feed } from "./types";
export function feedQuery(feed: Feed, page: number) {
  return database()
    .select({
      item_id: sql<number>`${items.id}`.as("item_id"),
      rank: entries.rank,
      title: items.title,
      url: items.url,
      author: items.author,
      created: items.created,
      score: items.score,
      comments: items.comments,
      type: items.type,
      committed_at: items.committedAt,
    })
    .from(entries)
    .innerJoin(items, eq(entries.itemId, items.id))
    .where(
      and(
        eq(entries.feed, feed),
        eq(items.deleted, false),
        eq(items.dead, false),
      ),
    )
    .orderBy(asc(entries.rank), asc(items.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
}
export function sealFeed(feed: Feed, page: number) {
  const secret = process.env.NEON_REALTIME_SECRET;
  if (!secret) throw new Error("NEON_REALTIME_SECRET is missing");
  const db = decodeURIComponent(
    new URL(process.env.DATABASE_URL!).pathname.slice(1),
  );
  return createRealtime({ secret, db, adapter: drizzleAdapter() }).seal({
    query: feedQuery(feed, page),
  });
}
export type SealedFeed = Awaited<ReturnType<typeof sealFeed>>;
