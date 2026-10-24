CREATE TABLE agent_gate_executions (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tree_hash TEXT NOT NULL,
  gates_hash TEXT NOT NULL,
  env_hash TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  gate_run TEXT NOT NULL,
  PRIMARY KEY (run_id, tree_hash, gates_hash, env_hash)
);
