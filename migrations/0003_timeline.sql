CREATE TABLE IF NOT EXISTS hn_events (
  id bigserial PRIMARY KEY,
  item_id integer NOT NULL,
  story_id integer NOT NULL,
  kind text NOT NULL,
  label text NOT NULL,
  details text NOT NULL,
  occurred_at bigint NOT NULL DEFAULT (extract(epoch FROM clock_timestamp()) * 1000)::bigint
);
CREATE INDEX IF NOT EXISTS hn_events_time ON hn_events(occurred_at);
ALTER TABLE hn_events REPLICA IDENTITY FULL;

-- Journal the actual mirror writes in the same fenced transaction. A row event
-- includes every changed field, including changes outside the current page.
CREATE OR REPLACE FUNCTION hn_record_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  current_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  delta jsonb := '{}'::jsonb;
  field_name text;
  event_kind text;
  event_label text;
  item integer;
  story integer;
BEGIN
  item := coalesce((current_row->>'item_id')::integer, (current_row->>'id')::integer);
  story := coalesce((current_row->>'story_id')::integer, item);
  IF TG_TABLE_NAME = 'hn_feed_entries' THEN
    event_kind := (current_row->>'feed') || '-' || CASE TG_OP WHEN 'INSERT' THEN 'entered' WHEN 'DELETE' THEN 'left' ELSE 'moved' END;
    SELECT title INTO event_label FROM hn_items WHERE id = item;
  ELSE
    event_kind := CASE TG_TABLE_NAME WHEN 'hn_comments' THEN 'comment' ELSE 'story' END || '-' || CASE TG_OP WHEN 'INSERT' THEN 'added' WHEN 'DELETE' THEN 'removed' ELSE 'updated' END;
    event_label := CASE TG_TABLE_NAME WHEN 'hn_comments' THEN 'Comment by ' || coalesce(current_row->>'author', 'unknown') ELSE coalesce(nullif(current_row->>'title', ''), 'HN item ' || item) END;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    FOR field_name IN SELECT jsonb_object_keys(current_row) LOOP
      IF field_name NOT IN ('committed_at','id','item_id','story_id','feed') AND previous->field_name IS DISTINCT FROM current_row->field_name THEN
        delta := delta || jsonb_build_object(field_name, jsonb_build_object('from', left(previous->>field_name, 300), 'to', left(current_row->>field_name, 300)));
      END IF;
    END LOOP;
    IF delta = '{}'::jsonb THEN RETURN NEW; END IF;
  ELSE
    delta := jsonb_strip_nulls(jsonb_build_object('rank',current_row->'rank','author',current_row->'author','text',left(current_row->>'text',300)));
  END IF;
  INSERT INTO hn_events(item_id,story_id,kind,label,details)
  VALUES(item,story,event_kind,coalesce(event_label,'HN item ' || item),delta::text);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION hn_prune_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM hn_events WHERE occurred_at < (extract(epoch FROM clock_timestamp()) * 1000)::bigint - 900000;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS hn_item_event ON hn_items;
CREATE TRIGGER hn_item_event AFTER INSERT OR UPDATE OR DELETE ON hn_items FOR EACH ROW EXECUTE FUNCTION hn_record_event();
DROP TRIGGER IF EXISTS hn_feed_event ON hn_feed_entries;
CREATE TRIGGER hn_feed_event AFTER INSERT OR UPDATE OR DELETE ON hn_feed_entries FOR EACH ROW EXECUTE FUNCTION hn_record_event();
DROP TRIGGER IF EXISTS hn_comment_event ON hn_comments;
CREATE TRIGGER hn_comment_event AFTER INSERT OR UPDATE OR DELETE ON hn_comments FOR EACH ROW EXECUTE FUNCTION hn_record_event();
DROP TRIGGER IF EXISTS hn_event_retention ON hn_items;
CREATE TRIGGER hn_event_retention AFTER INSERT OR UPDATE OR DELETE ON hn_items FOR EACH STATEMENT EXECUTE FUNCTION hn_prune_events();
