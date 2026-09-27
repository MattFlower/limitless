-- Optional state_json checkpoints: older releases ignore these keys; existing runs default
-- to no completed checks, no pending implementation and no completed delivery.
UPDATE runs SET state_json = json_set(state_json, '$.deliveryComplete', json('false'))
WHERE state_json IS NOT NULL AND json_type(state_json, '$.deliveryComplete') IS NULL;
