-- The poller's state per factory PR: `data` is the last successful observation plus its bookkeeping (JSON).
CREATE TABLE github_prs (url TEXT PRIMARY KEY, node_id TEXT, data TEXT, terminal INTEGER NOT NULL DEFAULT 0);
-- A repository's open access problem (JSON, NULL once cleared); `episode` numbers problems for dedupe.
CREATE TABLE github_access (repo TEXT PRIMARY KEY, problem TEXT, episode INTEGER NOT NULL);
