CREATE TABLE owner_diagnostics (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  invocation_id INTEGER REFERENCES invocations(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX owner_diagnostics_run ON owner_diagnostics(run_id, id);
