import { databasePool } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const { rows } = await databasePool()
      .query(`SELECT s.state, s.checked_at, s.committed_at,
      (l.active_until > now()) AS owned FROM ingest_status s CROSS JOIN ingest_leases l WHERE s.id = 1 AND l.id = 1`);
    const status = rows[0];
    const checkedAt = status?.checked_at
      ? new Date(status.checked_at).toISOString()
      : null;
    const fresh =
      checkedAt && Date.now() - Date.parse(checkedAt) < 30000 && status.owned;
    return Response.json(
      {
        state: fresh ? status.state : "degraded",
        checkedAt,
        committedAt: status?.committed_at ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { state: "degraded", checkedAt: null, committedAt: null },
      { status: 503 },
    );
  }
}
