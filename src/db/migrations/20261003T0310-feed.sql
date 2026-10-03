CREATE TABLE feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  run_id TEXT, eval_id TEXT, repo TEXT, title TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) <= 500),
  data TEXT NOT NULL DEFAULT '{}', dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX feed_ts ON feed (ts);
CREATE TABLE feed_cursors (consumer TEXT PRIMARY KEY, acked_id INTEGER NOT NULL CHECK (acked_id >= 0));
-- Producers are triggers, so an item commits or rolls back with the statement that changed state.
CREATE VIEW feed_add AS SELECT kind, run_id, eval_id, title, summary, data, dedupe_key FROM feed WHERE 0;
CREATE TRIGGER feed_add INSTEAD OF INSERT ON feed_add BEGIN
  INSERT INTO feed (ts, kind, run_id, eval_id, repo, title, summary, data, dedupe_key)
  VALUES (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), NEW.kind, NEW.run_id, NEW.eval_id,
    (SELECT slug FROM runs JOIN repos ON repos.id = runs.repo_id WHERE runs.id = NEW.run_id),
    substr(NEW.title, 1, 200), substr(NEW.summary, 1, 500), NEW.data, NEW.kind || ':' || NEW.dedupe_key)
  ON CONFLICT (dedupe_key) DO NOTHING;
END;
CREATE TRIGGER feed_run_status AFTER UPDATE OF status ON runs
WHEN NEW.status IN ('needs_human', 'failed', 'succeeded', 'cancelled') AND NEW.status IS NOT OLD.status BEGIN
  INSERT INTO feed_add VALUES ('run.' || NEW.status, NEW.id, NULL, 'Run ' || NEW.status || ': ' || NEW.title,
    coalesce(NEW.error, 'Run ' || NEW.status || coalesce(': ' || NEW.pr_url, '')),
    json_object('status', NEW.status, 'error', NEW.error, 'reason', NEW.error, 'prUrl', NEW.pr_url), NEW.id);
END;
-- A run whose dependency already failed is created blocked.
CREATE TRIGGER feed_run_blocked AFTER INSERT ON runs WHEN NEW.status = 'needs_human' BEGIN
  INSERT INTO feed_add VALUES ('run.needs_human', NEW.id, NULL, 'Run needs_human: ' || NEW.title,
    coalesce(NEW.error, 'Run needs_human'), json_object('status', NEW.status, 'reason', NEW.error), NEW.id);
END;
-- Only dependency reconciliation moves a run from waiting to queued.
CREATE TRIGGER feed_run_released AFTER UPDATE OF status ON runs WHEN OLD.status = 'waiting' AND NEW.status = 'queued' BEGIN
  INSERT INTO feed_add VALUES ('run.released', NEW.id, NULL, 'Released: ' || NEW.title, 'Dependencies merged; run queued',
    json_object('dependsOn', json(NEW.depends_on), 'status', NEW.status), NEW.id);
END;
CREATE TRIGGER feed_run_pr AFTER UPDATE OF pr_url ON runs WHEN coalesce(OLD.pr_url, '') = '' AND NEW.pr_url <> '' BEGIN
  INSERT INTO feed_add VALUES ('run.pr_opened', NEW.id, NULL, 'PR opened: ' || NEW.title, NEW.pr_url,
    json_object('prUrl', NEW.pr_url, 'status', NEW.status), NEW.id);
END;
CREATE TRIGGER feed_run_merged AFTER UPDATE OF merged ON runs WHEN NEW.merged AND NOT OLD.merged BEGIN
  INSERT INTO feed_add VALUES ('run.merged', NEW.id, NULL, 'Merged: ' || NEW.title,
    coalesce(NEW.pr_url, 'Run') || ' merged' || coalesce(' by ' || NEW.merged_by, ''), json_object('prUrl', NEW.pr_url,
    'mergedBy', NEW.merged_by, 'mergedAt', NEW.merged_at, 'status', NEW.status), NEW.id);
END;
CREATE TRIGGER feed_question AFTER INSERT ON questions BEGIN
  INSERT INTO feed_add SELECT 'run.question', id, NULL, 'Question: ' || title, NEW.question,
    json_object('questionId', NEW.id, 'question', NEW.question), NEW.id FROM runs WHERE id = NEW.run_id;
END;
-- Only an active eval finishes; a resume relabelling a finished predecessor is not a new completion.
CREATE TRIGGER feed_eval AFTER UPDATE OF status ON eval_runs
WHEN OLD.status IN ('queued', 'running') AND NEW.status NOT IN ('queued', 'running') BEGIN
  INSERT INTO feed_add VALUES ('eval.finished', NULL, NEW.id, 'Eval ' || NEW.id || ' ' || NEW.status,
    coalesce(NEW.error, NEW.role || ' eval ' || NEW.status),
    json_object('status', NEW.status, 'role', NEW.role, 'error', NEW.error, 'finishedAt', NEW.finished_at), NEW.id);
END;
