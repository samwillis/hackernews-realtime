import { Pool } from "pg";
import { Leases } from "../ingest/lease";
import { mapLimit, readHn, type HnItem } from "../ingest/source";
import { publish } from "../ingest/store";
import { FEED_SIZE } from "../lib/types";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const owner = `seed-${Date.now()}`;
const leases = new Leases(pool, owner, Date.now() + 120000, 90000, 30000);
let timer: ReturnType<typeof setInterval> | undefined;
try {
  const acquired = await leases.acquire();
  if (acquired.role !== "active")
    throw new Error(
      "An ingester already owns this branch. Stop it before seeding.",
    );
  timer = setInterval(
    () => void leases.renew("active", acquired.fencing, false),
    5000,
  );
  const [top, fresh] = await Promise.all([
    readHn<number[]>("topstories"),
    readHn<number[]>("newstories"),
  ]);
  const feeds = {
    top: top.slice(0, FEED_SIZE),
    new: fresh.slice(0, FEED_SIZE),
  };
  const items = new Map(
    await mapLimit(
      [...new Set([...feeds.top, ...feeds.new])],
      20,
      async (id) =>
        [
          id,
          (await readHn<HnItem | null>(`item/${id}`)) ?? { id, deleted: true },
        ] as const,
    ),
  );
  const changed = await publish(pool, leases, acquired.fencing, {
    feeds,
    items,
    receivedAt: Date.now(),
    reconciledAt: Date.now(),
    revision: 1,
  });
  console.log(`Seeded ${items.size} real HN items (${changed} changed rows).`);
} finally {
  clearInterval(timer);
  await leases.release();
  await pool.end();
}
