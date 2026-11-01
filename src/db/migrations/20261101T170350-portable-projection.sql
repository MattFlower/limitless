CREATE TABLE run_projection_ids (
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('stages', 'invocations', 'questions')),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  local_id INTEGER NOT NULL CHECK (local_id > 0),
  PRIMARY KEY (run_id, kind, ordinal),
  UNIQUE (run_id, kind, local_id)
);
CREATE TABLE run_projections (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  semantic_json TEXT NOT NULL
);
