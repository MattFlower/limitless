-- A review round: a run the review verdict handler created to apply findings onto the PR of
-- `source_run_id`. Only that handler writes rows; a row is the run's authority to push onto the PR branch.
CREATE TABLE review_rounds (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  source_run_id TEXT NOT NULL REFERENCES runs(id),
  pr_url TEXT NOT NULL,
  round INTEGER NOT NULL CHECK (round > 0),
  reviewed_sha TEXT NOT NULL,
  findings TEXT NOT NULL,
  delivered_sha TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (pr_url, round)
);
CREATE INDEX review_rounds_source ON review_rounds (source_run_id);
-- The last head seen on a PR. `version` grows with each new head, so a lookup that started
-- before a newer observation can be refused (compare-and-set) instead of rewinding it.
CREATE TABLE pr_heads (
  pr_url TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  version INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
-- `stale_reason` is set once the PR head moves (or a "changes" verdict arrives) after the approval.
CREATE TABLE review_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  pr_url TEXT NOT NULL,
  sha TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  findings_resolved INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  stale_reason TEXT
);
CREATE INDEX review_approvals_pr ON review_approvals (pr_url, id);
CREATE TRIGGER feed_review_round_started AFTER INSERT ON review_rounds BEGIN
  INSERT INTO feed_add (kind, run_id, eval_id, title, summary, data, dedupe_key)
  SELECT 'review.round_started', NEW.run_id, NULL, 'Review round ' || NEW.round || ' started: ' || title,
    json_array_length(NEW.findings) || ' finding(s) to address on ' || NEW.pr_url,
    json_object('prUrl', NEW.pr_url, 'round', NEW.round, 'sourceRunId', NEW.source_run_id,
      'reviewedSha', NEW.reviewed_sha, 'findings', json_array_length(NEW.findings)), NEW.run_id
  FROM runs WHERE id = NEW.run_id;
END;
CREATE TRIGGER feed_review_round_delivered AFTER UPDATE OF delivered_sha ON review_rounds
WHEN OLD.delivered_sha IS NULL AND NEW.delivered_sha IS NOT NULL BEGIN
  INSERT INTO feed_add (kind, run_id, eval_id, title, summary, data, dedupe_key)
  SELECT 'review.round_delivered', NEW.run_id, NULL, 'Review round ' || NEW.round || ' delivered: ' || title,
    'Pushed ' || substr(NEW.delivered_sha, 1, 12) || ' to ' || NEW.pr_url,
    json_object('prUrl', NEW.pr_url, 'round', NEW.round, 'sourceRunId', NEW.source_run_id,
      'headSha', NEW.delivered_sha), NEW.run_id
  FROM runs WHERE id = NEW.run_id;
END;
CREATE TRIGGER feed_review_approved AFTER INSERT ON review_approvals BEGIN
  INSERT INTO feed_add (kind, run_id, eval_id, title, summary, data, dedupe_key)
  SELECT 'review.approved', NEW.run_id, NULL, 'Approved: ' || title,
    NEW.pr_url || ' approved at ' || substr(NEW.sha, 1, 12) || ' by ' || NEW.reviewer,
    json_object('prUrl', NEW.pr_url, 'sha', NEW.sha, 'reviewer', NEW.reviewer,
      'findingsResolved', NEW.findings_resolved), NEW.id
  FROM runs WHERE id = NEW.run_id;
END;
