CREATE TABLE feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT,
  eval_id TEXT,
  repo TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) <= 500),
  data TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX feed_ts ON feed (ts);

CREATE TABLE feed_cursors (
  consumer TEXT PRIMARY KEY,
  acked_id INTEGER NOT NULL CHECK (acked_id >= 0),
  updated_at INTEGER NOT NULL
);
