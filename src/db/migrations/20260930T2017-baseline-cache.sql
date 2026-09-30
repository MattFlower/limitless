-- Completed prepare-stage baseline GateRuns, reused by later runs on the same base commit and
-- gate configuration. Entries expire after seven days (ignored on lookup, removed by GC).
CREATE TABLE baseline_cache (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  gates_hash TEXT NOT NULL,
  env_version INTEGER NOT NULL,
  gate_run TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, base_sha, gates_hash, env_version)
);
CREATE INDEX baseline_cache_created ON baseline_cache(created_at);

-- Per-run opt-out (--no-baseline-cache): execute the baseline, never read or write the cache.
ALTER TABLE runs ADD COLUMN no_baseline_cache INTEGER NOT NULL DEFAULT 0;
