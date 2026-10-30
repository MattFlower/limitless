CREATE TABLE eval_judgments (
  key TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  effort TEXT,
  case_id TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  matches_json TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE eval_judge_pairs (
  eval_run_id TEXT PRIMARY KEY REFERENCES eval_runs(id),
  judges_json TEXT NOT NULL
);
