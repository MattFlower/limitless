ALTER TABLE ci_failures ADD COLUMN rerun_retry_at INTEGER;
ALTER TABLE ci_failures ADD COLUMN rerun_retry_used INTEGER NOT NULL DEFAULT 0;
