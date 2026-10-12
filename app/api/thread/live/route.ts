import { parseStoryId } from "@/lib/comments";
import { sealStory, sealComments, storyQuery } from "@/lib/queries";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  let id: number;
  try {
    id = parseStoryId(new URL(request.url).searchParams.get("id"));
  } catch {
    return Response.json({ error: "Invalid story ID" }, { status: 400 });
  }
  try {
    if (!(await storyQuery(id)).length)
      return Response.json({ error: "Story not found" }, { status: 404 });
    const [story, comments] = await Promise.all([
      sealStory(id),
      sealComments(id),
    ]);
    return Response.json(
      { story, comments },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Unable to renew the discussion" },
      { status: 503 },
    );
  }
}
