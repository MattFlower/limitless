-- The validated request an eval run was submitted with, so `eval resume` can replay it unchanged,
-- and the links between an interrupted run and the run that resumed it. A run without a row
-- predates stored requests and cannot be resumed.
CREATE TABLE eval_run_requests (
  eval_run_id TEXT PRIMARY KEY REFERENCES eval_runs(id) ON DELETE CASCADE,
  request_json TEXT NOT NULL,
  resumed_from TEXT REFERENCES eval_runs(id),
  resumed_by TEXT REFERENCES eval_runs(id)
);
