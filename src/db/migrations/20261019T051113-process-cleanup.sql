CREATE TABLE process_cleanups (
  run_id TEXT NOT NULL,
  invocation TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pid INTEGER NOT NULL,
  birth TEXT NOT NULL,
  boot TEXT NOT NULL,
  PRIMARY KEY (invocation, pid, birth, boot)
);
