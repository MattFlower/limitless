-- Passing prepare-stage baseline GateRuns, reused by later runs on the same base commit, gate
-- configuration and gate environment (env_hash: lockfiles, Bun, platform, build, PATH/env digest).
-- Entries expire after seven days (ignored on lookup, removed by GC).
CREATE TABLE baseline_cache (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  gates_hash TEXT NOT NULL,
  env_hash TEXT NOT NULL,
  gate_run TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, base_sha, gates_hash, env_hash)
);
CREATE INDEX baseline_cache_created ON baseline_cache(created_at);

-- Per-run bypass (--no-baseline-cache): execute the baseline; a passing one refreshes the entry.
ALTER TABLE runs ADD COLUMN no_baseline_cache INTEGER NOT NULL DEFAULT 0;
