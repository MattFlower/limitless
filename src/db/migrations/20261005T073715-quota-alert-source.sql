ALTER TABLE quota_alerts ADD COLUMN source TEXT CHECK (source IN ('window', 'rejection'));
