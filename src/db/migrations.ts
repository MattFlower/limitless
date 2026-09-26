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
];
