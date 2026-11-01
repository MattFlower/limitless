CREATE TABLE run_policy_versions (
  run_id TEXT NOT NULL REFERENCES runs(id),
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version > 0),
  kind TEXT NOT NULL CHECK (kind IN ('provisional', 'prepared', 'review-finalized', 'scripts-refreshed')),
  digest TEXT NOT NULL UNIQUE CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, version)
);
CREATE TABLE run_policy_selections (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  policy_id TEXT NOT NULL,
  selected_version INTEGER NOT NULL,
  selected_digest TEXT NOT NULL,
  FOREIGN KEY (run_id, selected_version) REFERENCES run_policy_versions(run_id, version)
);
CREATE INDEX run_policy_selection_version ON run_policy_selections(run_id, selected_version);
CREATE TRIGGER run_policy_versions_immutable_update BEFORE UPDATE ON run_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'Immutable policy version');
END;
CREATE TRIGGER run_policy_versions_immutable_delete BEFORE DELETE ON run_policy_versions
BEGIN
  SELECT RAISE(ABORT, 'Immutable policy version');
END;
