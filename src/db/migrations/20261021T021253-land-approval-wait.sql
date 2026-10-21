-- Keep the shipped state CHECK and both active-entry indexes effective on rollback.
-- Logical waiting_approval entries remain physically checking and retain their claim.
ALTER TABLE land_entries ADD COLUMN approval_wait INTEGER NOT NULL DEFAULT 0;
