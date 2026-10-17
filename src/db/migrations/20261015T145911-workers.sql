CREATE TABLE workers (
  name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, token_hash TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','revoked')),
  pairing_code TEXT UNIQUE NOT NULL, pairing_secret_hash TEXT NOT NULL,
  pairing_expires_at INTEGER NOT NULL, last_heartbeat_at INTEGER, capabilities TEXT,
  created_at INTEGER NOT NULL, approved_at INTEGER, revoked_at INTEGER
);
