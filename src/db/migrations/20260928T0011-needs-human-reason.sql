-- Optional state_json key recording a needs_human verdict before its draft PR is delivered, so a
-- restart resumes delivery instead of the loop. Older releases ignore it; an absent key means no
-- pending verdict. Terminal runs already delivered theirs, so backfill from the recorded error.
UPDATE runs SET state_json = json_set(state_json, '$.needsHumanReason', error)
WHERE status = 'needs_human' AND error IS NOT NULL AND state_json IS NOT NULL
  AND json_type(state_json, '$.needsHumanReason') IS NULL;
