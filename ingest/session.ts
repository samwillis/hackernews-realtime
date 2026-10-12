import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { HnSource } from "./source";
import { Leases, LostLease } from "./lease";
import { publish } from "./store";
export interface SessionOptions {
  budgetMs?: number;
  tenureMs?: number;
  overlapMs?: number;
  owner?: string;
  signal?: AbortSignal;
}
export async function runSession(pool: Pool, options: SessionOptions = {}) {
  const arrived = Date.now();
  const budgetMs = options.budgetMs ?? 240000;
  const tenureMs = options.tenureMs ?? 120000;
  const overlapMs = options.overlapMs ?? 90000;
  if (
    ![budgetMs, tenureMs, overlapMs].every(Number.isFinite) ||
    budgetMs < 60000 ||
    budgetMs > 840000 ||
    tenureMs < 30000 ||
    tenureMs > budgetMs - 15000 ||
    overlapMs < 10000 ||
    overlapMs >= tenureMs
  )
    throw new Error("Invalid ingestion time budgets");
  const owner = options.owner ?? randomUUID();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const deadline = arrived + budgetMs;
  const leases = new Leases(pool, owner, deadline, tenureMs, overlapMs);
  const acquired = await leases.acquire();
  if (acquired.role === "skip") return { role: "skip", owner };
  let role = acquired.role;
  let fencing = acquired.fencing;
  let end = Math.min(arrived + tenureMs, deadline - 10000);
  let stopped = false;
  let transferred = false;
  let publishedRevision = -1;
  let renewing: Promise<void> | undefined;
  let reconciliation: Promise<void> | undefined;
  let standbyMarkedReady = false;
  let waitingForHandoff = false;
  const event = async (kind: string, details: Record<string, unknown> = {}) => {
    await pool.query(
      "INSERT INTO ingest_events(owner,kind,details) VALUES($1,$2,$3::jsonb)",
      [owner, kind, JSON.stringify(details)],
    );
    console.log(
      JSON.stringify({ owner, kind, at: new Date().toISOString(), ...details }),
    );
  };
  const source = new HnSource(owner, signal);
  const promote = async () => {
    const promoted = await leases.promoteIfNeeded();
    if (!promoted) return false;
    role = "active";
    fencing = promoted.fencing;
    end = promoted.end;
    publishedRevision = -1;
    await event("promoted", {
      deadline: new Date(deadline).toISOString(),
      end: new Date(end).toISOString(),
    });
    await pool.query(
      `UPDATE ingest_status SET handoff_ms=EXTRACT(epoch FROM (clock_timestamp()-handoff_at))*1000 WHERE id=1 AND handoff_at>clock_timestamp()-interval '30 seconds'`,
    );
    return true;
  };
  const renew = async () => {
    try {
      let valid = await leases.renew(role, fencing, source.ready);
      // Transfer can occur between the standby poll and its renewal.
      if (!valid && role === "standby" && (await promote()))
        valid = await leases.renew("active", fencing, source.ready);
      if (!valid) {
        stopped = true;
        controller.abort(new LostLease());
        return;
      }
      if (role === "active") {
        await pool.query(
          `UPDATE ingest_status SET state=$1, checked_at=CASE WHEN $1='healthy' THEN clock_timestamp() ELSE checked_at END,
          reconciled_at=$2, owner=$3 WHERE id=1 AND EXISTS(SELECT 1 FROM ingest_leases WHERE id=1 AND active_owner=$3 AND fencing=$4 AND active_until>clock_timestamp())`,
          [
            source.ready
              ? "healthy"
              : source.connected
                ? "starting"
                : "reconnecting",
            source.snapshot.reconciledAt
              ? new Date(source.snapshot.reconciledAt)
              : null,
            owner,
            fencing,
          ],
        );
      }
    } catch {
      stopped = true;
      controller.abort(new LostLease());
    }
  };
  const heartbeat = setInterval(() => {
    if (!renewing)
      renewing = renew().finally(() => {
        renewing = undefined;
      });
  }, 5000);
  const timeout = setTimeout(() => {
    stopped = true;
    controller.abort();
  }, budgetMs - 5000);
  const shutdown = () => {
    stopped = true;
    controller.abort();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await event("started", { role, budgetMs, tenureMs, overlapMs });
    await source.reconcile();
    await renew();
    while (!stopped && !signal.aborted && Date.now() < deadline - 5000) {
      if (source.needsReconcile && !reconciliation) {
        reconciliation = source
          .reconcile()
          .catch(async () => {
            source.failed = true;
            await event("source_failed");
          })
          .finally(() => {
            reconciliation = undefined;
          });
      }
      if (role === "standby") {
        if (source.ready) {
          if (!standbyMarkedReady) {
            await leases.renew("standby", fencing, true);
            standbyMarkedReady = true;
          }
          await promote();
        }
      } else {
        if (source.ready && source.snapshot.revision !== publishedRevision) {
          const snapshot = source.copy();
          await publish(pool, leases, fencing, snapshot);
          publishedRevision = snapshot.revision;
        }
        if (Date.now() >= end) {
          const next = await leases.handoff(fencing);
          if (next) {
            transferred = true;
            await event("handoff", { to: next });
            break;
          }
          // Scheduled delivery can arrive late. Continue publishing within the
          // original request budget while waiting for a prepared successor.
          if (!waitingForHandoff) {
            waitingForHandoff = true;
            await event("handoff_waiting");
          }
        }
      }
      await delay(250, undefined, { signal }).catch(() => {});
    }
    if (waitingForHandoff && !transferred) await event("handoff_unavailable");
    return { role, owner, transferred, durationMs: Date.now() - arrived };
  } catch (error) {
    await event(error instanceof LostLease ? "lost_lease" : "session_failed");
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timeout);
    controller.abort();
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await source.close();
    await reconciliation?.catch(() => {});
    await renewing?.catch(() => {});
    await leases.release();
    await pool.query(
      `UPDATE ingest_status SET state='degraded', failure_at=clock_timestamp(), failure='Session ended without handoff'
      WHERE id=1 AND owner=$1 AND NOT EXISTS(SELECT 1 FROM ingest_leases WHERE id=1 AND active_until>clock_timestamp())`,
      [owner],
    );
    await event("finished", { transferred, durationMs: Date.now() - arrived });
  }
}
