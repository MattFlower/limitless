CREATE TABLE runtime_models (
  id TEXT PRIMARY KEY,
  definition_json TEXT NOT NULL
);
CREATE TABLE served_models (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (provider, model)
);
CREATE TABLE model_discovery (
  provider TEXT PRIMARY KEY,
  served_json TEXT,
  observed_at INTEGER
);
