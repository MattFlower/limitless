CREATE TABLE verifier_screenshots (
  run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL, content TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (run_id, name)
);
