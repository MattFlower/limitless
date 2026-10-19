CREATE TABLE process_cleanups (
  run_id TEXT,
  invocation TEXT NOT NULL,
  directory TEXT NOT NULL,
  pid INTEGER NOT NULL,
  birth TEXT NOT NULL,
  boot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (invocation, pid)
);
CREATE INDEX process_cleanups_run ON process_cleanups(run_id);
