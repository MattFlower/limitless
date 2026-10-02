-- Passing prepare-stage baseline GateRuns only, reused by later runs on the same base commit, gate
-- configuration and gate environment (env_hash: lockfiles, Bun, platform, build, PATH/env digest).
-- Entries expire after seven days (ignored on lookup, removed by GC).
CREATE TABLE passing_baselines (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  gates_hash TEXT NOT NULL,
  env_hash TEXT NOT NULL,
  gate_run TEXT NOT NULL,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, base_sha, gates_hash, env_hash)
);
CREATE INDEX passing_baselines_created ON passing_baselines(created_at);

-- Per-run opt-out (--no-baseline-cache): execute the baseline, never read the cache.
ALTER TABLE runs ADD COLUMN no_baseline_cache INTEGER NOT NULL DEFAULT 0;
