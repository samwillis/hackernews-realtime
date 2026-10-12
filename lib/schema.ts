import {
  pgTable,
  integer,
  text,
  boolean,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
export const items = pgTable("hn_items", {
  id: integer("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  url: text("url"),
  author: text("author"),
  created: integer("created").notNull(),
  score: integer("score").notNull(),
  comments: integer("comments").notNull(),
  deleted: boolean("deleted").notNull(),
  dead: boolean("dead").notNull(),
  committedAt: text("committed_at").notNull(),
});
export const entries = pgTable(
  "hn_feed_entries",
  {
    feed: text("feed").notNull(),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id),
    rank: integer("rank").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.feed, t.itemId] }),
    index("hn_feed_rank").on(t.feed, t.rank, t.itemId),
  ],
);
