CREATE TABLE defect_outbox (
  source_ref TEXT NOT NULL,
  source_key TEXT NOT NULL,
  destination TEXT,
  signature TEXT,
  occurrence TEXT UNIQUE,
  title TEXT,
  body TEXT,
  comment_body TEXT,
  app_login TEXT,
  operation TEXT CHECK (operation IN ('issue', 'comment')),
  target_issue INTEGER,
  object_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'sending', 'delivered', 'uncertain', 'held', 'blocked', 'suppressed', 'no-report')),
  diagnostic TEXT,
  reservation_day TEXT,
  scan_page INTEGER NOT NULL DEFAULT 1 CHECK (scan_page > 0),
  scan_matches TEXT NOT NULL DEFAULT '[]',
  scan_blocked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_ref, source_key)
);
CREATE INDEX defect_outbox_reservations ON defect_outbox (reservation_day);
CREATE INDEX defect_outbox_pending ON defect_outbox (state);
CREATE TABLE defect_signatures (
  destination TEXT NOT NULL,
  signature TEXT NOT NULL,
  barrier_occurrence TEXT REFERENCES defect_outbox (occurrence),
  issue_number INTEGER,
  PRIMARY KEY (destination, signature)
);
CREATE INDEX defect_signatures_barrier ON defect_signatures (barrier_occurrence);
