ALTER TABLE provider_state ADD COLUMN fast INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invocations ADD COLUMN fast INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invocations ADD COLUMN fast_mode_state TEXT;
ALTER TABLE invocations ADD COLUMN fast_mode_disabled_reason TEXT;
