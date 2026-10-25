CREATE TABLE issue_lifecycle_effects (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  effect TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT,
  comment_id INTEGER,
  login TEXT,
  page INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, repo, number, effect)
);
-- Suppress only events already observed before lifecycle support, including across restarts.
INSERT INTO issue_lifecycle_effects (run_id, repo, number, effect, state)
  SELECT id, '', 0, 'comment:started', 'done' FROM runs;
INSERT INTO issue_lifecycle_effects (run_id, repo, number, effect, state)
  SELECT id, '', 0, 'comment:pr', 'done' FROM runs WHERE pr_url IS NOT NULL;
INSERT INTO issue_lifecycle_effects (run_id, repo, number, effect, state)
  SELECT id, '', 0, 'comment:' || status, 'done' FROM runs
  WHERE status IN ('needs_human', 'failed', 'cancelled');
INSERT INTO issue_lifecycle_effects (run_id, repo, number, effect, state)
  SELECT id, '', 0, 'observed', json_array(status, pr_url, merged, pr_closed_unmerged) FROM runs
  WHERE status IN ('succeeded', 'failed', 'cancelled', 'resolved');
