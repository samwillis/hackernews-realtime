import { parseStoryId } from "@/lib/comments";
import { watchThread } from "@/lib/thread-watch";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  let id: number;
  const params = new URL(request.url).searchParams;
  const viewer = params.get("viewer") ?? undefined;
  if (
    viewer &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      viewer,
    )
  )
    return Response.json({ error: "Invalid viewer ID" }, { status: 400 });
  try {
    id = parseStoryId(new URL(request.url).searchParams.get("id"));
  } catch {
    return Response.json({ error: "Invalid story ID" }, { status: 400 });
  }
  try {
    const health = await watchThread(id, viewer, params.get("release") === "1");
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
