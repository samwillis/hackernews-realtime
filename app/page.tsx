import { notFound } from "next/navigation";
import { feedQuery, sealFeed } from "@/lib/queries";
import { parseFeedPage, sortStories } from "@/lib/types";
import { NewsClient } from "./news-client";
import { fixture } from "@/lib/fixture";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let selection;
  try {
    selection = parseFeedPage(
      typeof params.feed === "string" ? params.feed : undefined,
      typeof params.page === "string" ? params.page : undefined,
    );
  } catch {
    notFound();
  }
  const { feed, page } = selection;
  const fixtureMode =
    process.env.HN_FIXTURE === "1" && process.env.NODE_ENV !== "production";
  if (fixtureMode)
    return (
      <NewsClient
        key={`${feed}-${page}`}
        feed={feed}
        page={page}
        initialRows={fixture(feed, page)}
        query={null}
        initialNow={Date.now()}
      />
    );
  const [rows, query] = await Promise.all([
    feedQuery(feed, page),
    sealFeed(feed, page),
  ]);
  return (
    <NewsClient
      key={`${feed}-${page}`}
      feed={feed}
      page={page}
      initialRows={sortStories(rows)}
      query={query}
      initialNow={Date.now()}
    />
  );
}
