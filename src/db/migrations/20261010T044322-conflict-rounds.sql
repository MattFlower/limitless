-- Keep existing columns and default review behavior for the previous release.
DROP TRIGGER feed_review_round_started;
DROP TRIGGER feed_review_round_delivered;
CREATE TABLE review_rounds_next (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  source_run_id TEXT NOT NULL REFERENCES runs(id),
  pr_url TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round > 0),
  reviewed_sha TEXT NOT NULL,
  findings TEXT NOT NULL,
  delivered_sha TEXT,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'review' CHECK (kind IN ('review', 'conflict')),
  UNIQUE (pr_url, kind, round)
);
INSERT INTO review_rounds_next (run_id, source_run_id, pr_url, round, reviewed_sha, findings, delivered_sha, created_at)
SELECT run_id, source_run_id, pr_url, round, reviewed_sha, findings, delivered_sha, created_at FROM review_rounds;
DROP TABLE review_rounds;
ALTER TABLE review_rounds_next RENAME TO review_rounds;
CREATE INDEX review_rounds_source ON review_rounds (source_run_id);
CREATE TABLE conflict_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_url TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('land', 'poller')),
  land_entry_id INTEGER REFERENCES land_entries(id),
  observed_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'started', 'skipped')),
  run_id TEXT REFERENCES runs(id),
  reason TEXT
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
