-- What a restarted daemon needs to resume an eval run: its cache setting and the dataset as
-- submitted. New tables, not columns, so the previous release's positional INSERTs still work.
-- A run without a row predates resume and still fails on restart.
CREATE TABLE eval_run_resume (
  eval_run_id TEXT PRIMARY KEY REFERENCES eval_runs(id) ON DELETE CASCADE,
  cache INTEGER NOT NULL,
  dataset_json TEXT NOT NULL,
  -- 'active' while a daemon owns the run, 'interrupted' after a shutdown stopped it, 'done' after.
  state TEXT NOT NULL
);
-- Durable intent written before every eval harness call and resolved when it returns. A call
-- that never resolved may have spent money without a record, so its trial is never replayed.
-- usage_known is 1 only when the harness reported authoritative final usage; a timeout, kill or
-- transport failure that returned without it leaves the call's spend unknown.
CREATE TABLE eval_call_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eval_run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  trial_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  status TEXT,
  cost_usd REAL,
  cost_equiv_usd REAL,
  usage_known INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX eval_call_attempts_run ON eval_call_attempts(eval_run_id);
