CREATE TABLE eval_run_options (
  eval_run_id TEXT PRIMARY KEY REFERENCES eval_runs(id) ON DELETE CASCADE,
  rounds INTEGER NOT NULL DEFAULT 1,
  strategy TEXT NOT NULL DEFAULT 'retry'
);
