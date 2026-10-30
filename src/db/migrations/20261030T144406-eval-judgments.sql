CREATE TABLE eval_judgments (
  cache_key TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  matches_json TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE eval_judges (
  eval_run_id TEXT PRIMARY KEY REFERENCES eval_runs(id),
  job_json TEXT NOT NULL
);
