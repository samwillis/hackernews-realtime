import { parseStoryId } from "./comments";
import { parseFeedPage } from "./types";

export function liveRoute(href: string) {
  const url = new URL(href, "https://hackernews-realtime.vercel.app");
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  if (url.pathname === "/") {
    const { feed, page } = parseFeedPage(
      url.searchParams.get("feed"),
      url.searchParams.get("page"),
    );
    return {
      kind: "feed" as const,
      key: `feed:${feed}:${page}`,
      api: `/api/feed/live?feed=${feed}&page=${page}`,
    };
  }
  if (url.pathname === "/item") {
    const id = parseStoryId(url.searchParams.get("id"));
    return {
      kind: "thread" as const,
      key: `thread:${id}`,
      id,
      api: `/api/thread/live?id=${id}`,
    };
  }
  return null;
}

export class NavigationIntent {
  private generation = 0;
  begin() {
    const generation = ++this.generation;
    return () => generation === this.generation;
  }
  cancel() {
    this.generation++;
  }
}
