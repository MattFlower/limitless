-- Additive JSON evidence: eval_trials.details_json may now contain switchChain;
-- rounds may contain harness and resumeFailed. All are optional for legacy readers.
-- No table rewrite or backfill: historical trials did not capture this evidence.
SELECT 1;
