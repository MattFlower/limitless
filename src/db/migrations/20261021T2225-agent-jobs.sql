CREATE TABLE agent_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  invocation_id INTEGER,
  request TEXT NOT NULL,
  parent_sha TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','leased','done','failed','cancelled')),
  worker TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  lease_expires_at INTEGER,
  attempt_deadline_at INTEGER,
  result TEXT,
  result_sha TEXT,
  failure_reason TEXT,
  excluded TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agent_jobs_state_created ON agent_jobs(state, created_at);
