-- Additive: explicit-column writes from the previous slot schema remain valid on rollback.
-- Releases predating shared slots ignore these tables and continue using in-memory pools.
-- Identity-less ordinary reservations are retained conservatively until explicitly released.
ALTER TABLE slot_requests ADD COLUMN owner_pid INTEGER;
ALTER TABLE slot_requests ADD COLUMN owner_birth TEXT;
