-- Blocked storage keeps approval waits unclaimable by the previous release.
-- The marker records the start of the current wait episode in milliseconds.
ALTER TABLE land_entries ADD COLUMN approval_wait INTEGER NOT NULL DEFAULT 0;
