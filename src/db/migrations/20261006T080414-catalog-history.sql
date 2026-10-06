CREATE TABLE catalog_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT,
  note TEXT,
  at INTEGER NOT NULL
);
