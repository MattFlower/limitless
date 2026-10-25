-- Keep terminal history idle until its state changes, rather than permanently excluding it.
-- PRs already merged or closed while excluded also need one label reconciliation.
INSERT OR IGNORE INTO issue_lifecycle_effects (run_id, repo, number, effect, state)
  SELECT r.id, '', 0, 'observed', json_array(r.status, r.pr_url, 0, 0)
  FROM runs r WHERE EXISTS (
    SELECT 1 FROM issue_lifecycle_effects e
    WHERE e.run_id = r.id AND e.effect = 'excluded:terminal'
  );
DELETE FROM issue_lifecycle_effects WHERE effect = 'excluded:terminal';
