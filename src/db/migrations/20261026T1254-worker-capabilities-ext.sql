-- Capabilities the previous release's strict heartbeat schema rejects (a Linux worker's), kept out
-- of `capabilities` so that release still parses every row it reads.
ALTER TABLE workers ADD COLUMN capabilities_ext TEXT;
