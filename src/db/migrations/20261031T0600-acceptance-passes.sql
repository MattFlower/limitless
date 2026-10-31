CREATE TABLE acceptance_passes (
  repo TEXT NOT NULL,
  epic INTEGER NOT NULL,
  pass INTEGER NOT NULL,
  ticket INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  items TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (repo, epic, pass)
);
CREATE TABLE acceptance_epic_limits (
  repo TEXT NOT NULL,
  epic INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  label TEXT NOT NULL,
  comment TEXT NOT NULL,
  PRIMARY KEY (repo, epic)
);
