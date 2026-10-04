CREATE TRIGGER feed_gate_timeout_retry AFTER UPDATE OF state_json ON runs
WHEN coalesce(json_extract(NEW.state_json, '$.gateTimeoutReruns'), 0) >
     coalesce(json_extract(OLD.state_json, '$.gateTimeoutReruns'), 0) BEGIN
  INSERT INTO feed_add VALUES ('run.gate_timeout_retry', NEW.id, NULL,
    'Gate timeout re-run: ' || NEW.title,
    'Timeout-caused gate re-runs: ' || json_extract(NEW.state_json, '$.gateTimeoutReruns'),
    json_object('gateTimeoutReruns', json_extract(NEW.state_json, '$.gateTimeoutReruns')),
    NEW.id || ':' || json_extract(NEW.state_json, '$.gateTimeoutReruns'));
END;
