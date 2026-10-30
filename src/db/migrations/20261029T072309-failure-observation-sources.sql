ALTER TABLE failure_observations ADD COLUMN purpose TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE failure_observations ADD COLUMN slow_regression INTEGER NOT NULL DEFAULT 0;
ALTER TABLE failure_observations ADD COLUMN reason TEXT;
