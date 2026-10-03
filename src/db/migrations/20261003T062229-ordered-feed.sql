DROP TRIGGER feed_run_pr;
DROP TRIGGER feed_run_merged;
DROP TRIGGER feed_run_status;
-- One trigger makes compound updates publish in causal order.
CREATE TRIGGER feed_run_update AFTER UPDATE ON runs BEGIN
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
END;
