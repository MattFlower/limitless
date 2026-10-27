CREATE TABLE github_processed_comments (
  repo TEXT NOT NULL CHECK (repo = lower(repo)),
  comment_id INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('run', 'refused')),
  run_id TEXT,
  note TEXT,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (repo, comment_id)
);

CREATE TABLE github_comment_boundaries (
  repo TEXT PRIMARY KEY CHECK (repo = lower(repo)),
  github_at TEXT NOT NULL
);
