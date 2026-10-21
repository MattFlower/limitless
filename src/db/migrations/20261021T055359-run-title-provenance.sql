ALTER TABLE runs ADD COLUMN title_provenance TEXT CHECK (title_provenance IN ('explicit', 'defaulted'));
