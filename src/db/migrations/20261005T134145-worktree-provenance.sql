ALTER TABLE runs ADD COLUMN worktree_provenance TEXT;

-- 7405d9f introduced sidecars on 2026-10-04 at 07:35:04 UTC. Only factory
-- evidence that prepare had reached a worktree before then establishes legacy
-- eligibility. Creation time alone does not; later prepare attempts are ambiguous.
UPDATE runs SET worktree_provenance = 'legacy'
WHERE NOT EXISTS (
  SELECT 1 FROM stages WHERE run_id = runs.id AND name = 'prepare'
    AND started_at >= 1791099304000
) AND EXISTS (
  SELECT 1 FROM stages WHERE run_id = runs.id AND name = 'prepare'
    AND started_at < 1791099304000
    AND ((status = 'succeeded' AND finished_at < 1791099304000)
      OR EXISTS (SELECT 1 FROM events WHERE run_id = runs.id AND type = 'gate'
        AND ts >= stages.started_at
        AND ts <= COALESCE(stages.finished_at, 1791099303999)
        AND ts < 1791099304000))
);
