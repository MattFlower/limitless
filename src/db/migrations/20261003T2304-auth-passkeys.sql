-- WebAuthn passkeys that may sign in to the UI: `id` is the base64url credential ID, `public_key`
-- its COSE key, `counter` the last signature counter seen, `transports` a JSON array of hints.
CREATE TABLE auth_passkeys (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  device TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
