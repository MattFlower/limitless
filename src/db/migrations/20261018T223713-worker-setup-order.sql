ALTER TABLE workers ADD COLUMN setup_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN setup_warning_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE gate_jobs ADD COLUMN setup_order INTEGER NOT NULL DEFAULT 0;

-- Give pre-existing jobs a durable order before allocating newer leases.
UPDATE gate_jobs SET setup_order=rowid;
UPDATE workers SET setup_order=(SELECT coalesce(max(setup_order),0) FROM gate_jobs);
UPDATE workers SET setup_warning_order=setup_order WHERE setup_warning IS NOT NULL;
