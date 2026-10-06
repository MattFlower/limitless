ALTER TABLE runs ADD COLUMN worktree_provenance TEXT;

-- The runner verifies persisted daemon build identities against protected application
-- history. Without a verified start, cutoff is NULL and no run gains eligibility.
-- Creation time alone is insufficient; later prepare attempts are ambiguous.
UPDATE runs SET worktree_provenance = 'legacy'
FROM (SELECT MIN(ts) AS cutoff FROM legacy_sidecar_starts)
WHERE NOT EXISTS (
  SELECT 1 FROM stages WHERE run_id = runs.id AND name = 'prepare'
    AND started_at >= cutoff
) AND EXISTS (
  SELECT 1 FROM stages WHERE run_id = runs.id AND name = 'prepare'
    AND started_at < cutoff
    AND ((status = 'succeeded' AND finished_at < cutoff)
      OR EXISTS (SELECT 1 FROM events WHERE run_id = runs.id AND type = 'gate'
        AND ts >= stages.started_at
        AND ts <= COALESCE(stages.finished_at, cutoff - 1)
        AND ts < cutoff))
);
DROP TABLE legacy_sidecar_starts;
