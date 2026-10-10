-- Preserve the previous release's table and shared round sequence.
ALTER TABLE review_rounds ADD COLUMN kind TEXT NOT NULL DEFAULT 'review';
DROP TRIGGER IF EXISTS feed_review_round_started;
DROP TRIGGER IF EXISTS feed_review_round_delivered;
CREATE TABLE conflict_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_url TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('land', 'poller')),
  land_entry_id INTEGER REFERENCES land_entries(id),
  observed_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'started', 'skipped')),
  run_id TEXT REFERENCES runs(id),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER feed_review_round_started AFTER INSERT ON review_rounds BEGIN
  INSERT INTO feed_add (kind, run_id, eval_id, title, summary, data, dedupe_key)
  SELECT NEW.kind || '.round_started', NEW.run_id, NULL, CASE NEW.kind WHEN 'conflict' THEN 'Conflict round ' ELSE 'Review round ' END || NEW.round || ' started: ' || title,
    CASE NEW.kind WHEN 'conflict' THEN 'Resolving conflicts on ' || NEW.pr_url ELSE json_array_length(NEW.findings) || ' finding(s) to address on ' || NEW.pr_url END,
    json_object('prUrl', NEW.pr_url, 'round', NEW.round, 'sourceRunId', NEW.source_run_id,
      'reviewedSha', NEW.reviewed_sha, 'findings', json_array_length(NEW.findings)), NEW.run_id
  FROM runs WHERE id = NEW.run_id;
END;
CREATE TRIGGER feed_review_round_delivered AFTER UPDATE OF delivered_sha ON review_rounds
WHEN OLD.delivered_sha IS NULL AND NEW.delivered_sha IS NOT NULL BEGIN
  INSERT INTO feed_add (kind, run_id, eval_id, title, summary, data, dedupe_key)
  SELECT NEW.kind || '.round_delivered', NEW.run_id, NULL, CASE NEW.kind WHEN 'conflict' THEN 'Conflict round ' ELSE 'Review round ' END || NEW.round || ' delivered: ' || title,
    CASE NEW.kind WHEN 'conflict' THEN 'Conflict resolved at ' || NEW.delivered_sha || '; approve the new head to land' ELSE 'Pushed ' || substr(NEW.delivered_sha, 1, 12) || ' to ' || NEW.pr_url END,
    json_object('prUrl', NEW.pr_url, 'round', NEW.round, 'sourceRunId', NEW.source_run_id,
      'headSha', NEW.delivered_sha), NEW.run_id
  FROM runs WHERE id = NEW.run_id;
END;
