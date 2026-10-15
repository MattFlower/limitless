CREATE TABLE workers (
  name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, token_hash TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','revoked')),
  pairing_code TEXT UNIQUE NOT NULL, pairing_secret_hash TEXT NOT NULL,
  pairing_expires_at INTEGER NOT NULL, last_heartbeat_at INTEGER, capabilities TEXT,
  created_at INTEGER NOT NULL, approved_at INTEGER, revoked_at INTEGER
);
CREATE TABLE gate_jobs (
  id TEXT PRIMARY KEY, run_id TEXT, request TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','leased','done','failed','cancelled')),
  worker TEXT, attempt INTEGER NOT NULL DEFAULT 1, lease_expires_at INTEGER,
  result TEXT, failure_reason TEXT, excluded TEXT NOT NULL DEFAULT '[]',
  events TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX gate_jobs_queue ON gate_jobs(state, created_at);
