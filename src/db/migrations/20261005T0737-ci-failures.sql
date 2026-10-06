CREATE TABLE ci_failures (
  pr_url TEXT NOT NULL,
  sha TEXT NOT NULL,
  signature TEXT NOT NULL,
  check_name TEXT NOT NULL,
  error_line TEXT NOT NULL,
  runner_image TEXT,
  outcome TEXT NOT NULL DEFAULT 'failed',
  rerun_claimed INTEGER NOT NULL DEFAULT 0,
  rerun_marker TEXT,
  PRIMARY KEY (pr_url, sha, signature)
);
