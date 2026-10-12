import { parseStoryId } from "@/lib/comments";
import { watchThread } from "@/lib/thread-watch";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  let id: number;
  try {
    id = parseStoryId(new URL(request.url).searchParams.get("id"));
  } catch {
    return Response.json({ error: "Invalid story ID" }, { status: 400 });
  }
  try {
    const health = await watchThread(id);
    if (!health)
      return Response.json({ error: "Story not found" }, { status: 404 });
    return Response.json(health, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { state: "degraded", checkedAt: null, committedAt: null },
      { status: 503 },
    );
  }
}
