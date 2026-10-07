CREATE TRIGGER feed_signal_warning AFTER INSERT ON events
WHEN NEW.level = 'warn' AND json_extract(NEW.data, '$.code') = 'signal_attempt' BEGIN
  -- feed_add prefixes the key with run.warning; deduplicate by invocation, independent of tool ids.
  INSERT INTO feed_add VALUES ('run.warning', NEW.run_id, NULL, 'Process signal attempt',
    NEW.message, json_object('invocationId', NEW.invocation_id, 'eventId', NEW.id, 'toolCallId', json_extract(NEW.data, '$.id')),
    NEW.run_id || ':' || NEW.invocation_id);
END;
