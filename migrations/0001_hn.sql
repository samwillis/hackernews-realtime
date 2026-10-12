CREATE TABLE IF NOT EXISTS hn_items (
  id integer PRIMARY KEY, type text NOT NULL, title text NOT NULL, url text,
  author text, created integer NOT NULL, score integer NOT NULL DEFAULT 0,
  comments integer NOT NULL DEFAULT 0, deleted boolean NOT NULL DEFAULT false,
  dead boolean NOT NULL DEFAULT false, committed_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS hn_feed_entries (
  feed text NOT NULL CHECK (feed IN ('top','new')), item_id integer NOT NULL REFERENCES hn_items(id),
  rank integer NOT NULL CHECK (rank > 0), PRIMARY KEY (feed,item_id)
);
CREATE INDEX IF NOT EXISTS hn_feed_rank ON hn_feed_entries(feed,rank,item_id);
ALTER TABLE hn_items REPLICA IDENTITY FULL;
ALTER TABLE hn_feed_entries REPLICA IDENTITY FULL;
CREATE TABLE IF NOT EXISTS ingest_leases (
  id integer PRIMARY KEY CHECK (id=1), active_owner text, active_until timestamptz,
  active_session_end timestamptz, active_deadline timestamptz, fencing bigint NOT NULL DEFAULT 0,
  standby_owner text, standby_until timestamptz, standby_deadline timestamptz,
  standby_ready boolean NOT NULL DEFAULT false, heartbeat_at timestamptz
);
INSERT INTO ingest_leases(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ingest_status (
  id integer PRIMARY KEY CHECK(id=1), state text NOT NULL DEFAULT 'starting',
  checked_at timestamptz, reconciled_at timestamptz, source_event_at timestamptz,
  committed_at timestamptz, failure_at timestamptz, failure text,
  handoff_at timestamptz, handoff_from text, handoff_ms integer,
  owner text, writes bigint NOT NULL DEFAULT 0
);
INSERT INTO ingest_status(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ingest_events (
  id bigserial PRIMARY KEY, owner text NOT NULL, kind text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ingest_events_time ON ingest_events(occurred_at);
