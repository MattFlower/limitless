CREATE TABLE defect_enablement_windows (
  start INTEGER NOT NULL, end INTEGER,
  CHECK (end IS NULL OR end >= start)
);
CREATE UNIQUE INDEX defect_enablement_open ON defect_enablement_windows ((1)) WHERE end IS NULL;
CREATE INDEX defect_enablement_start ON defect_enablement_windows (start, end);
CREATE TABLE defect_observation_consumption (
  observation_id INTEGER PRIMARY KEY REFERENCES failure_observations(id),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'no-report', 'blocked', 'suppressed', 'unresolved'))
);
CREATE INDEX failure_observations_defect_pending ON failure_observations (finalized_at, id)
  WHERE purpose='land' AND interim=0 AND class IS NOT NULL AND finalized_at IS NOT NULL;
