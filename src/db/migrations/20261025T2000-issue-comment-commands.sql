CREATE TABLE issue_comment_streams (
  repo TEXT PRIMARY KEY COLLATE NOCASE,
  initialized_at TEXT NOT NULL,
  since TEXT NOT NULL,
  page INTEGER NOT NULL DEFAULT 1,
  pending TEXT
);
CREATE TABLE issue_comment_commands (
  repo TEXT NOT NULL COLLATE NOCASE,
  comment_id INTEGER NOT NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  note TEXT NOT NULL,
  PRIMARY KEY (repo, comment_id)
);
CREATE INDEX issue_comment_commands_run ON issue_comment_commands(run_id);
