CREATE TABLE run_transfer_receipts (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  manifest TEXT NOT NULL,
  digest TEXT NOT NULL,
  fingerprint TEXT NOT NULL
);
CREATE TABLE run_transfer_blobs (
  run_id TEXT NOT NULL REFERENCES run_transfer_receipts(run_id),
  slot INTEGER NOT NULL CHECK (slot >= 0),
  blob_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  plaintext BLOB NOT NULL,
  PRIMARY KEY (run_id, slot)
);
