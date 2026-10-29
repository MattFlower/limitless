CREATE INDEX repos_slug_lower ON repos(lower(slug));
CREATE INDEX runs_source_ref_repo ON runs(lower(json_extract(source_ref, '$.repo')));
