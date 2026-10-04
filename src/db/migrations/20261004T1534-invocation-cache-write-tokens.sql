-- Cache-write tokens are kept beside cache reads; input_tokens now holds uncached input only.
ALTER TABLE invocations ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0);
