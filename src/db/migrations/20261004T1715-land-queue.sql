-- Approved pull requests waiting to be landed, one at a time per repository.
-- `approved_sha` is the operator's approval: only it and a base merge the factory made may land.
CREATE TABLE land_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  approved_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN
    ('queued', 'checking', 'waiting_ci', 'merging', 'landed', 'blocked', 'cancelled')),
  pushed_sha TEXT,
  ci_rerun TEXT,
  log_path TEXT,
  claim_owner TEXT,
  claim_heartbeat_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX land_entries_queue ON land_entries (repo, state, id);
-- At most one entry per PR may be in flight; a land that has landed, blocked or been cancelled frees it.
CREATE UNIQUE INDEX land_entries_active ON land_entries (pr_url) WHERE state IN
  ('queued', 'checking', 'waiting_ci', 'merging');
-- A repository is landed one at a time: claiming a second entry while one runs fails here.
CREATE UNIQUE INDEX land_entries_one_running ON land_entries (repo) WHERE state IN
  ('checking', 'waiting_ci', 'merging');