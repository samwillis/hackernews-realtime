import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
const schema = `hn_recovery_${Date.now()}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const url = new URL(process.env.DATABASE_URL_UNPOOLED!);
url.searchParams.set("options", `-c search_path=${schema}`);
const pool = new Pool({ connectionString: url.href });
const children: ChildProcess[] = [];
const results: Record<string, number> = {};
const launch = () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/ingest.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: url.href,
        INGEST_REQUEST_BUDGET_MS: "180000",
        INGEST_TENURE_MS: "90000",
        INGEST_OVERLAP_MS: "60000",
      },
      stdio: "ignore",
    },
  );
  children.push(child);
  return child;
};
async function waitFor(check: () => Promise<boolean>, limit = 120000) {
  const until = Date.now() + limit;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error("Recovery probe timed out");
}
const lease = async () =>
  (await pool.query("SELECT * FROM ingest_leases WHERE id=1")).rows[0];
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(
    await readFile(
      new URL("../migrations/0001_hn.sql", import.meta.url),
      "utf8",
    ),
  );
  const first = launch();
  await waitFor(
    async () =>
      (await pool.query("SELECT state FROM ingest_status WHERE id=1")).rows[0]
        .state === "healthy",
  );
  const firstOwner = (await lease()).active_owner;
  await delay(31000);
  const standby = launch();
  await waitFor(async () => (await lease()).standby_ready);
  const warmStart = Date.now();
  first.kill("SIGKILL");
  await waitFor(async () => {
    const state = await lease();
    return (
      state.active_owner !== firstOwner &&
      (await pool.query("SELECT owner,state FROM ingest_status WHERE id=1"))
        .rows[0].state === "healthy"
    );
  });
  results.warmRecoveryMs = Date.now() - warmStart;
  console.log("Warm recovery:", results.warmRecoveryMs, "ms");
  const secondOwner = (await lease()).active_owner;
  const coldStart = Date.now();
  standby.kill("SIGKILL");
  // Model the worst phase of the one-minute scheduler, with no prepared standby.
  await delay(60000);
  launch();
  await waitFor(async () => {
    const state = await lease();
    const health = (
      await pool.query("SELECT owner,state FROM ingest_status WHERE id=1")
    ).rows[0];
    return (
      state.active_owner !== secondOwner &&
      health.owner === state.active_owner &&
      health.state === "healthy"
    );
  }, 60000);
  results.coldRecoveryMs = Date.now() - coldStart;
  console.log("Cold recovery:", results.coldRecoveryMs, "ms");
  if (results.warmRecoveryMs > 120000 || results.coldRecoveryMs > 120000)
    throw new Error("Recovery budget exceeded");
  await writeFile(
    new URL("../.local/recovery-results.json", import.meta.url),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        environment:
          "isolated staging schema, real HN source, local Node process killed with SIGKILL",
        ...results,
      },
      null,
      2,
    ),
  );
} finally {
  children.forEach((child) => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  await delay(2000);
  children.forEach((child) => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
