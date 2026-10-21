CREATE TABLE github_observation_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO github_observation_sequence (id, value) VALUES (1, 0);
ALTER TABLE land_entries ADD COLUMN approval_wait_request_seq INTEGER NOT NULL DEFAULT 0;
