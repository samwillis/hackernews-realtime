ALTER TABLE hn_threads ADD COLUMN IF NOT EXISTS loaded_at timestamptz;
ALTER TABLE hn_threads ADD COLUMN IF NOT EXISTS initial_load_owner uuid;
ALTER TABLE hn_threads ADD COLUMN IF NOT EXISTS initial_load_until timestamptz;
UPDATE hn_threads SET loaded_at=COALESCE(committed_at,checked_at,clock_timestamp())
WHERE loaded_at IS NULL AND (state='healthy' OR EXISTS(
  SELECT 1 FROM hn_comments WHERE hn_comments.story_id=hn_threads.story_id
));

CREATE TABLE IF NOT EXISTS hn_thread_views (
  viewer_id uuid NOT NULL, story_id integer NOT NULL REFERENCES hn_items(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released boolean NOT NULL DEFAULT false,
  PRIMARY KEY(viewer_id,story_id)
);
CREATE INDEX IF NOT EXISTS hn_active_thread_views ON hn_thread_views(requested_at,story_id) WHERE NOT released;
