-- Audit exemptions explicitly allowed by the requester (JSON array); legacy runs allow nothing.
ALTER TABLE runs ADD COLUMN audit_allow TEXT NOT NULL DEFAULT '[]';
