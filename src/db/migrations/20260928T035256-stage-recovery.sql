-- Additive state checkpoints; absent round, SHA and retry keys intentionally mean no cached evidence.
UPDATE runs SET state_json = json_set(state_json, '$.deliveryComplete', json('false'))
WHERE state_json IS NOT NULL AND json_type(state_json, '$.deliveryComplete') IS NULL;

-- A terminal verdict remains authoritative when an operator resumes its draft delivery.
UPDATE runs SET state_json = json_set(state_json, '$.needsHumanReason', error)
WHERE status = 'needs_human' AND error IS NOT NULL AND state_json IS NOT NULL
  AND json_type(state_json, '$.needsHumanReason') IS NULL;
