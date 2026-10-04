-- Start existing closed snapshots' retention window when this release first observes them.
ALTER TABLE github_prs ADD COLUMN closed_at INTEGER;
ALTER TABLE github_prs ADD COLUMN reopened_at INTEGER;
UPDATE github_prs SET closed_at = unixepoch('now') * 1000 WHERE data ->> 'state' = 'CLOSED';
