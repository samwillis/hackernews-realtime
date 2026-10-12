import { PAGE_SIZE, type Feed, type Story } from "./types";
const titles = [
  ["Show HN: A tiny database that fits in your pocket", "https://neon.com"],
  ["The quiet art of making software last", "https://example.com/software"],
  ["Ask HN: What are you working on?", null],
  ["A visual introduction to how Postgres works", "https://www.postgresql.org"],
  [
    "Building a better web, one small page at a time",
    "https://example.com/web",
  ],
];
export function fixture(feed: Feed, page: number): Story[] {
  return Array.from({ length: PAGE_SIZE }, (_, index) => ({
    item_id: (feed === "top" ? 1000 : 2000) + (page - 1) * PAGE_SIZE + index,
    rank: (page - 1) * PAGE_SIZE + index + 1,
    title: titles[index % titles.length][0]!,
    url: titles[index % titles.length][1],
    author: ["dang", "sama", "pg", "tptacek"][index % 4],
    created: 1791806400 - index * 600,
    score: 245 - index * 5,
    comments: 60 - index,
    type: "story",
    committed_at: "2026-10-12T08:00:00.000Z",
  }));
}
