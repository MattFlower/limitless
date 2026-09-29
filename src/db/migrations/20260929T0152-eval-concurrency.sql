-- Per-provider trial concurrency requested for an eval run. A separate table (not a column on
-- eval_run_options) so the previous release's positional INSERT still works; missing rows read as 2.
CREATE TABLE eval_run_concurrency (
  eval_run_id TEXT PRIMARY KEY REFERENCES eval_runs(id) ON DELETE CASCADE,
  concurrency INTEGER NOT NULL
);
