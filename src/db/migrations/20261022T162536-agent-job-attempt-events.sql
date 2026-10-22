CREATE TABLE agent_job_attempt_events (
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  events TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, attempt, seq)
);
