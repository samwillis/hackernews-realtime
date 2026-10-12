ALTER TABLE hn_items ADD COLUMN IF NOT EXISTS body text;
CREATE TABLE IF NOT EXISTS hn_threads (
  story_id integer PRIMARY KEY REFERENCES hn_items(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  checked_at timestamptz, committed_at timestamptz,
  state text NOT NULL DEFAULT 'starting', truncated boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS hn_comments (
  story_id integer NOT NULL REFERENCES hn_items(id), item_id integer NOT NULL,
  parent_id integer NOT NULL, path text NOT NULL, depth integer NOT NULL,
  author text, created integer NOT NULL, text text NOT NULL,
  deleted boolean NOT NULL, dead boolean NOT NULL, committed_at text NOT NULL,
  PRIMARY KEY(story_id,item_id)
);
CREATE INDEX IF NOT EXISTS hn_comment_order ON hn_comments(story_id,path,item_id);
ALTER TABLE hn_comments REPLICA IDENTITY FULL;
