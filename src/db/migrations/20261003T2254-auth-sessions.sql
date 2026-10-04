-- Browser sign-in sessions for non-loopback UI access. Only a SHA-256 of the cookie's secret is
-- kept; `id` is a separate handle for listing and revoking. Expiry is computed from the timestamps.
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL,
  device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
