CREATE TABLE routing_cells (
  role TEXT NOT NULL,
  cell TEXT NOT NULL,
  groups_json TEXT NOT NULL,
  note TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (role, cell)
);
CREATE TABLE routing_prefer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  providers_json TEXT NOT NULL,
  note TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE routing_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  old_json TEXT,
  new_json TEXT,
  note TEXT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL
);
