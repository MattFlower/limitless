-- Additive JSON evidence in runs.state_json: gateEvidence records the candidate gate stage ID,
-- checked SHA and resolved test commands; verifyResults records the verified SHA and each
-- engine-owned gateEvidence. The original parsed modelOutput is stored privately for resume.
-- GateResult JSON may also include testCoverage, captured before output truncation.
-- No backfill: historical gate results lack commit provenance and cannot satisfy blocked tests.
-- All fields are optional for the previous release; no table rewrite is needed.
SELECT 1;
