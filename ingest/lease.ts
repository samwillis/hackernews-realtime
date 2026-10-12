import type { Pool, PoolClient } from "pg";
export interface Lease {
  active_owner: string | null;
  active_until: Date | null;
  active_session_end: Date | null;
  active_deadline: Date | null;
  fencing: string;
  standby_owner: string | null;
  standby_until: Date | null;
  standby_deadline: Date | null;
  standby_ready: boolean;
}
export class LostLease extends Error {
  constructor() {
    super("Ingestion ownership lost");
  }
}
export class Leases {
  constructor(
    private pool: Pool,
    readonly owner: string,
    readonly deadline: number,
    private tenureMs: number,
    private overlapMs: number,
  ) {}
  async transaction<T>(
    fn: (client: PoolClient, lease: Lease, now: number) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT *, clock_timestamp() AS db_now FROM ingest_leases WHERE id=1 FOR UPDATE",
      );
      const result = await fn(
        client,
        rows[0],
        new Date(rows[0].db_now).getTime(),
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private sessionEnd(now: number) {
    return new Date(Math.min(now + this.tenureMs, this.deadline - 10000));
  }
  async acquire(): Promise<{
    role: "active" | "standby" | "skip";
    fencing: string;
  }> {
    return this.transaction(async (client, lease, now) => {
      const activeValid =
        lease.active_owner && lease.active_until && +lease.active_until > now;
      const standbyValid =
        lease.standby_owner &&
        lease.standby_until &&
        +lease.standby_until > now;
      if (
        !activeValid &&
        (!standbyValid ||
          !lease.standby_ready ||
          lease.standby_owner === this.owner)
      ) {
        const { rows } = await client.query(
          `UPDATE ingest_leases SET active_owner=$1, active_until=clock_timestamp()+interval '20 seconds',
          active_session_end=$2, active_deadline=$3, fencing=fencing+1, standby_owner=NULL, standby_until=NULL,
          standby_deadline=NULL, standby_ready=false WHERE id=1 RETURNING fencing`,
          [this.owner, this.sessionEnd(now), new Date(this.deadline)],
        );
        return { role: "active", fencing: String(rows[0].fencing) };
      }
      if (
        activeValid &&
        lease.active_session_end &&
        +lease.active_session_end - now <= this.overlapMs &&
        !standbyValid
      ) {
        await client.query(
          `UPDATE ingest_leases SET standby_owner=$1, standby_until=clock_timestamp()+interval '20 seconds', standby_deadline=$2, standby_ready=false WHERE id=1`,
          [this.owner, new Date(this.deadline)],
        );
        return { role: "standby", fencing: lease.fencing };
      }
      return { role: "skip", fencing: lease.fencing };
    });
  }
  async renew(
    role: "active" | "standby",
    fencing: string,
    ready: boolean,
  ): Promise<boolean> {
    const { rowCount } =
      role === "active"
        ? await this.pool.query(
            `UPDATE ingest_leases SET active_until=clock_timestamp()+interval '20 seconds', heartbeat_at=clock_timestamp()
        WHERE id=1 AND active_owner=$1 AND fencing=$2 AND active_until>clock_timestamp() AND active_deadline>clock_timestamp()`,
            [this.owner, fencing],
          )
        : await this.pool.query(
            `UPDATE ingest_leases SET standby_until=clock_timestamp()+interval '20 seconds', standby_ready=$2
        WHERE id=1 AND standby_owner=$1 AND standby_until>clock_timestamp() AND standby_deadline>clock_timestamp()`,
            [this.owner, ready],
          );
    return rowCount === 1;
  }
  async assert(client: PoolClient, fencing: string) {
    const { rowCount } = await client.query(
      `SELECT id FROM ingest_leases WHERE id=1 AND active_owner=$1 AND fencing=$2
      AND active_until>clock_timestamp() AND active_deadline>clock_timestamp() FOR UPDATE`,
      [this.owner, fencing],
    );
    if (!rowCount) throw new LostLease();
  }
  async promoteIfNeeded(): Promise<{ fencing: string; end: number } | null> {
    return this.transaction(async (client, lease, now) => {
      if (
        lease.active_owner === this.owner &&
        lease.active_until &&
        +lease.active_until > now
      )
        return { fencing: lease.fencing, end: +lease.active_session_end! };
      if (
        lease.standby_owner !== this.owner ||
        !lease.standby_ready ||
        !lease.standby_until ||
        +lease.standby_until <= now ||
        (lease.active_until && +lease.active_until > now)
      )
        return null;
      const { rows } = await client.query(
        `UPDATE ingest_leases SET active_owner=$1, active_until=clock_timestamp()+interval '20 seconds',
        active_session_end=$2, active_deadline=$3, fencing=fencing+1, standby_owner=NULL, standby_until=NULL, standby_ready=false WHERE id=1 RETURNING fencing`,
        [this.owner, this.sessionEnd(now), new Date(this.deadline)],
      );
      return { fencing: String(rows[0].fencing), end: +this.sessionEnd(now) };
    });
  }
  async handoff(fencing: string): Promise<string | null> {
    return this.transaction(async (client, lease, now) => {
      await this.assert(client, fencing);
      if (
        !lease.standby_owner ||
        !lease.standby_ready ||
        !lease.standby_until ||
        +lease.standby_until <= now ||
        !lease.standby_deadline ||
        +lease.standby_deadline - now < 15000
      )
        return null;
      const next = lease.standby_owner;
      const end = new Date(
        Math.min(now + this.tenureMs, +lease.standby_deadline - 10000),
      );
      await client.query(
        `UPDATE ingest_leases SET active_owner=standby_owner, active_until=clock_timestamp()+interval '20 seconds',
        active_session_end=$1, active_deadline=standby_deadline, fencing=fencing+1, standby_owner=NULL,
        standby_until=NULL, standby_deadline=NULL, standby_ready=false WHERE id=1`,
        [end],
      );
      await client.query(
        `UPDATE ingest_status SET handoff_at=clock_timestamp(), handoff_from=$1 WHERE id=1`,
        [this.owner],
      );
      return next;
    });
  }
  async release() {
    await this.pool.query(
      `UPDATE ingest_leases SET active_until=clock_timestamp() WHERE id=1 AND active_owner=$1`,
      [this.owner],
    );
    await this.pool.query(
      `UPDATE ingest_leases SET standby_until=clock_timestamp(), standby_ready=false WHERE id=1 AND standby_owner=$1`,
      [this.owner],
    );
  }
}
