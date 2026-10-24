CREATE TABLE issue_lifecycle_effects (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  effect TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (run_id, repo, number, effect)
);
INSERT INTO issue_lifecycle_effects SELECT id, '', 0, 'legacy', 'done' FROM runs;
