-- Whether a run may reuse cached trials, so an eval resumed after a restart keeps its --no-cache.
ALTER TABLE eval_run_options ADD COLUMN cache INTEGER NOT NULL DEFAULT 1;
