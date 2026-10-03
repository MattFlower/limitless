-- The poller's last successful observation of each factory PR. `revision` counts observations that
-- produced feed items, so a later transition on the same head gets a fresh dedupe key.
CREATE TABLE github_prs (
  url TEXT PRIMARY KEY, repo TEXT NOT NULL, node_id TEXT, snapshot TEXT,
  revision INTEGER NOT NULL DEFAULT 0, unknown_polls INTEGER NOT NULL DEFAULT 0,
  nudged_head TEXT, terminal INTEGER NOT NULL DEFAULT 0
);
-- One row per repository that ever had an access problem; `reason` is NULL once it clears.
CREATE TABLE github_access (
  repo TEXT PRIMARY KEY, reason TEXT, detail TEXT NOT NULL, since INTEGER NOT NULL, episode INTEGER NOT NULL
);
