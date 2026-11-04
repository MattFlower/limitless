CREATE TABLE shared_checkpoints (
  run_id TEXT PRIMARY KEY,
  committed_generation INTEGER, committed_sequence INTEGER, committed_pointer TEXT,
  committed_manifest TEXT, committed_commits TEXT,
  pending_generation INTEGER, pending_sequence INTEGER, pending_pointer TEXT,
  pending_manifest TEXT, pending_commits TEXT,
  terminal_json TEXT,
  indexed INTEGER NOT NULL DEFAULT 0 CHECK (indexed IN (0, 1)),
  updated_at INTEGER NOT NULL
);
