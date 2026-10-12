import { sealFeed } from "@/lib/queries";
import { parseFeedPage } from "@/lib/types";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const { feed, page } = parseFeedPage(
      params.get("feed"),
      params.get("page"),
    );
    return Response.json(await sealFeed(feed, page), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Error && /Invalid feed|Page must/.test(error.message))
      return Response.json({ error: error.message }, { status: 400 });
    console.error("seal_failed");
    return Response.json(
      { error: "Unable to connect. Please retry." },
      { status: 503 },
    );
  }
}
