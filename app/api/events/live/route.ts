import { eventQuery, sealEvents } from "@/lib/queries";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const [events, query] = await Promise.all([
      new URL(request.url).searchParams.has("capability")
        ? Promise.resolve([])
        : eventQuery(),
      sealEvents(),
    ]);
    return Response.json(
      { events, query },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Unable to load live events" },
      { status: 503 },
    );
  }
}
