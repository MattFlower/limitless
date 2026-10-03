-- How a resolved run was dealt with (JSON: kind, ref, note, by, at); NULL for every other status.
ALTER TABLE runs ADD COLUMN resolution TEXT;
-- Only a confirmed merge resolved runs before; the trigger below doesn't watch this column, so no feed items.
UPDATE runs SET resolution = json_object('kind', 'merged', 'ref', pr_url, 'note', NULL, 'by', 'github',
  'at', coalesce(merged_at, finished_at, created_at)) WHERE status = 'resolved';
DROP TRIGGER feed_run_update;
CREATE TRIGGER feed_run_update AFTER UPDATE OF status, pr_url, merged ON runs BEGIN
  INSERT INTO feed_add SELECT 'run.pr_opened', NEW.id, NULL, 'PR opened: ' || NEW.title, NEW.pr_url,
    json_object('prUrl', NEW.pr_url, 'status', NEW.status), NEW.id
    WHERE coalesce(OLD.pr_url, '') = '' AND NEW.pr_url <> '';
  INSERT INTO feed_add SELECT 'run.merged', NEW.id, NULL, 'Merged: ' || NEW.title,
    coalesce(NEW.pr_url, 'Run') || ' merged' || coalesce(' by ' || NEW.merged_by, ''),
    json_object('prUrl', NEW.pr_url, 'mergedBy', NEW.merged_by, 'mergedAt', NEW.merged_at, 'status', NEW.status), NEW.id
    WHERE NEW.merged AND NOT OLD.merged;
  -- The next durable sequence value distinguishes even transitions in the same millisecond.
  INSERT INTO feed_add SELECT 'run.' || NEW.status, NEW.id, NULL, 'Run ' || NEW.status || ': ' || NEW.title,
    coalesce(NEW.error, 'Run ' || NEW.status || coalesce(': ' || NEW.pr_url, '')),
    json_object('status', NEW.status, 'error', NEW.error, 'reason', NEW.error, 'prUrl', NEW.pr_url),
    NEW.id || ':' || (SELECT coalesce(max(seq), 0) + 1 FROM sqlite_sequence WHERE name = 'feed')
    WHERE NEW.status IN ('needs_human', 'failed', 'succeeded', 'cancelled') AND OLD.status IS NOT NEW.status;
  INSERT INTO feed_add SELECT 'run.resolved', NEW.id, NULL, 'Resolved (' || (NEW.resolution ->> 'kind') || '): ' || NEW.title,
    'Run resolved as ' || (NEW.resolution ->> 'kind') || coalesce(': ' || (NEW.resolution ->> 'ref'), '')
      || coalesce(' — ' || (NEW.resolution ->> 'note'), ''),
    json_object('kind', NEW.resolution ->> 'kind', 'ref', NEW.resolution ->> 'ref', 'note', NEW.resolution ->> 'note',
      'by', NEW.resolution ->> 'by', 'status', NEW.status, 'prUrl', NEW.pr_url), NEW.id
    WHERE NEW.status = 'resolved' AND OLD.status IS NOT NEW.status;
END;
