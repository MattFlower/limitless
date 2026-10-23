-- The previous release ignores these tables and keeps its in-memory semaphore, so rollback is safe.
CREATE TABLE slot_pools (
  pool TEXT PRIMARY KEY,
  capacity INTEGER NOT NULL
);
CREATE TABLE slot_requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  pool TEXT NOT NULL,
  owner TEXT NOT NULL,
  holder TEXT NOT NULL,
  priority TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  lease_until INTEGER,
  held_order INTEGER NOT NULL
);
CREATE INDEX slot_requests_pool ON slot_requests(pool);
