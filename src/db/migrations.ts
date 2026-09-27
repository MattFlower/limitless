// Numbered, append-only schema migrations. Never edit a shipped migration; add a new one.

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('github','local')),
  url TEXT,
  local_path TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  merge_policy TEXT NOT NULL DEFAULT 'auto',
  profile_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  requested_by TEXT,
  profile TEXT NOT NULL DEFAULT 'auto',
  resolved_profile TEXT,
  task_class TEXT,
  complexity TEXT,
  status TEXT NOT NULL,
  stage TEXT,
  base_branch TEXT,
  base_sha TEXT,
  branch TEXT,
  head_sha TEXT,
  pr_url TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_equiv_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX runs_status ON runs(status, priority DESC, created_at);
CREATE INDEX runs_created ON runs(created_at DESC);

CREATE TABLE stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  summary TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX stages_run ON stages(run_id, id);

CREATE TABLE invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  stage_id INTEGER REFERENCES stages(id),
  role TEXT NOT NULL,
  harness TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_equiv_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  num_turns INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX invocations_run ON invocations(run_id, id);
CREATE INDEX invocations_provider ON invocations(provider, started_at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  invocation_id INTEGER,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX events_run ON events(run_id, id);

CREATE TABLE artifacts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, name)
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  question TEXT NOT NULL,
  answer TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER,
  answered_by TEXT
);
CREATE INDEX questions_run ON questions(run_id);

CREATE TABLE provider_state (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  reason TEXT,
  until INTEGER,
  windows_json TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT,
  note TEXT
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  run_id TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX chat_conv ON chat_messages(conversation_id, id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "existing_pr_delivery",
    sql: "ALTER TABLE runs ADD COLUMN delivery_branch TEXT;",
  },
  {
    version: 3,
    name: "verified_github_origin",
    sql: "ALTER TABLE runs ADD COLUMN github_webhook_verified INTEGER NOT NULL DEFAULT 0;",
  },
  {
    version: 4,
    name: "quota_alerts",
    sql: `
CREATE TABLE quota_alerts (
  provider TEXT NOT NULL,
  window TEXT NOT NULL,
  boundary INTEGER NOT NULL,
  resets_at INTEGER,
  utilization REAL,
  severity TEXT NOT NULL,
  routing TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider, window, boundary)
);
`,
  },
  {
    version: 5,
    name: "chat_concierge",
    sql: `
ALTER TABLE chat_messages ADD COLUMN outcome_json TEXT;
CREATE TABLE chat_proposals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','superseded','confirmed','consumed')),
  confirmed_at INTEGER,
  run_id TEXT UNIQUE REFERENCES runs(id)
);
CREATE UNIQUE INDEX chat_current ON chat_proposals(conversation_id) WHERE state IN ('pending','confirmed');
CREATE TABLE chat_receipts (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);
CREATE TABLE chat_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE INDEX chat_calls_provider ON chat_calls(provider, started_at);
`,
  },
  {
    version: 6,
    name: "openrouter_key_usage",
    sql: `
ALTER TABLE provider_state ADD COLUMN reported_usage_usd REAL;
ALTER TABLE provider_state ADD COLUMN reported_at INTEGER;
ALTER TABLE provider_state ADD COLUMN key_limit REAL;
ALTER TABLE provider_state ADD COLUMN limit_remaining REAL;
ALTER TABLE provider_state ADD COLUMN limit_reset TEXT;
`,
  },
  {
    version: 7,
    name: "delivery_rebase_round_checkpoint",
    sql: `
UPDATE runs SET state_json = json_set(state_json, '$.conflictRound', json_extract(state_json, '$.round'))
WHERE json_type(state_json, '$.conflictRound') = 'true';
UPDATE runs SET state_json = json_remove(state_json, '$.conflictRound')
WHERE json_type(state_json, '$.conflictRound') = 'false';
`,
  },
  {
    version: 8,
    name: "triage_evals",
    sql: `
CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  models TEXT NOT NULL,
  k INTEGER NOT NULL,
  max_usd REAL NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT
);
CREATE TABLE eval_trials (
  eval_run_id TEXT NOT NULL REFERENCES eval_runs(id),
  case_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  trial INTEGER NOT NULL,
  cache_key TEXT NOT NULL,
  harness TEXT NOT NULL,
  status TEXT NOT NULL,
  output_json TEXT,
  pass INTEGER,
  score REAL,
  details_json TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_equiv_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (eval_run_id, case_id, model_id, trial)
);
CREATE INDEX eval_trials_cache_key ON eval_trials(cache_key);
`,
  },
];
