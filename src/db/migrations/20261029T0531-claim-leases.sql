CREATE TABLE claim_leases (
  repo TEXT NOT NULL CHECK (repo = lower(repo)), ref TEXT NOT NULL, run_id TEXT NOT NULL,
  confirmed_generation INTEGER, confirmed_tip TEXT,
  confirmed_state TEXT CHECK (confirmed_state IN ('held','released','lost')),
  intent_op TEXT CHECK (intent_op IN ('acquire','renew','update','release')),
  intent_before TEXT, intent_record TEXT, intent_commit TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, ref)
);
