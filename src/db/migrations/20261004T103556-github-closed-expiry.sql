-- Start existing closed snapshots' retention window when this release first observes them.
CREATE TABLE github_pr_expiry (url TEXT PRIMARY KEY, closed_at INTEGER, reopened_at INTEGER);
INSERT INTO github_pr_expiry (url, closed_at)
SELECT url, unixepoch('now') * 1000 FROM github_prs WHERE data ->> 'state' = 'CLOSED';
