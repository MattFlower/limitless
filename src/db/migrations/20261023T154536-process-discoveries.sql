CREATE TABLE process_discoveries (
  invocation TEXT PRIMARY KEY,
  run_id TEXT,
  directory TEXT NOT NULL,
  boot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  discovery TEXT NOT NULL
);
