CREATE TABLE queue_epic_attention (
  repo TEXT NOT NULL,
  epic INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (repo, epic)
);
