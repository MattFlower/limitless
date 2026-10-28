CREATE TABLE failure_observations (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, repo TEXT NOT NULL, stage_id INTEGER NOT NULL,
  round INTEGER NOT NULL, sha TEXT NOT NULL, handle_kind TEXT NOT NULL, handle_id TEXT NOT NULL,
  phase TEXT NOT NULL, name TEXT NOT NULL, command TEXT NOT NULL, location TEXT, os TEXT,
  load_per_core REAL, observed_at INTEGER NOT NULL, exit_code INTEGER, timed_out INTEGER NOT NULL,
  confinement INTEGER NOT NULL, duration_ms REAL NOT NULL, failed_files TEXT NOT NULL,
  output_tail TEXT NOT NULL, signature TEXT NOT NULL, setup_eligible INTEGER NOT NULL,
  class TEXT, history TEXT, finalized_at INTEGER, interim INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, handle_kind, handle_id, phase, name)
);
CREATE INDEX failure_observations_signature ON failure_observations (repo, signature, observed_at);
ALTER TABLE gate_jobs ADD COLUMN worker_os TEXT;
