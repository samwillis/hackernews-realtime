-- Private, fenced work queue. Neither table participates in public live queries.
CREATE TABLE IF NOT EXISTS hn_ingest_pending (
  key text PRIMARY KEY,
  due_at bigint NOT NULL,
  received_at bigint NOT NULL,
  revision bigint NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS hn_ingest_pending_due ON hn_ingest_pending(due_at);

-- The first worker reconciliation fills a discussion immediately, including
-- rows omitted by the small cold-page seed. Only subsequent live changes wait.
ALTER TABLE hn_threads ADD COLUMN IF NOT EXISTS ingest_initialized boolean NOT NULL DEFAULT false;
