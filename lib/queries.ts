import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { createRealtime } from "@neon/realtime/server";
import { drizzleAdapter } from "@neon/realtime-drizzle";
import { database } from "./db";
import { entries, items, comments } from "./schema";
import { THREAD_LIMIT } from "./comments";
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
function realtime() {
  const secret = process.env.NEON_REALTIME_SECRET;
  if (!secret) throw new Error("NEON_REALTIME_SECRET is missing");
  const db = decodeURIComponent(
    new URL(process.env.DATABASE_URL!).pathname.slice(1),
  );
  return createRealtime({ secret, db, adapter: drizzleAdapter() });
}
export function sealFeed(feed: Feed, page: number) {
  return realtime().seal({
    query: feedQuery(feed, page),
  });
}
export type SealedFeed = Awaited<ReturnType<typeof sealFeed>>;
export function storyQuery(id: number) {
  return database()
    .select({
      item_id: sql<number>`${items.id}`.as("item_id"),
      rank: sql<number>`0`.as("rank"),
      title: items.title,
      url: items.url,
      author: items.author,
      created: items.created,
      score: items.score,
      comments: items.comments,
      type: items.type,
      body: items.body,
      committed_at: items.committedAt,
    })
    .from(items)
    .where(eq(items.id, id))
    .limit(1);
}
export function commentQuery(id: number) {
  return database()
    .select({
      story_id: comments.storyId,
      item_id: comments.itemId,
      parent_id: comments.parentId,
      path: comments.path,
      depth: comments.depth,
      author: comments.author,
      created: comments.created,
      text: comments.text,
      deleted: comments.deleted,
      dead: comments.dead,
      committed_at: comments.committedAt,
    })
    .from(comments)
    .where(eq(comments.storyId, id))
    .orderBy(asc(comments.path), asc(comments.itemId))
    .limit(THREAD_LIMIT);
}
export function sealStory(id: number) {
  return realtime().seal({ query: storyQuery(id) });
}
export function sealComments(id: number) {
  return realtime().seal({ query: commentQuery(id) });
}
export type SealedStory = Awaited<ReturnType<typeof sealStory>>;
export type SealedComments = Awaited<ReturnType<typeof sealComments>>;
