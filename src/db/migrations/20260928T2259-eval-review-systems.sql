-- Review eval candidates (ReviewSystem configs with resolved targets), one JSON array per run.
CREATE TABLE eval_run_systems (
  eval_run_id TEXT PRIMARY KEY REFERENCES eval_runs(id) ON DELETE CASCADE,
  systems_json TEXT NOT NULL
);
-- Two systems may share a target, so a trial's identity also includes details_json.system.
-- Rows without a system keep their old identity; the previous release's upserts still conflict here.
DROP INDEX eval_trials_identity;
CREATE UNIQUE INDEX eval_trials_system_identity ON eval_trials(
  eval_run_id, case_id, model_id, trial, COALESCE(effort, ''),
  COALESCE(json_extract(details_json, '$.system'), '')
);
