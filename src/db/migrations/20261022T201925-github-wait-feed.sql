CREATE TRIGGER feed_waiting_github AFTER UPDATE OF state_json ON runs
WHEN json_extract(NEW.state_json, '$.githubWait.since') IS NOT NULL AND
     json_extract(NEW.state_json, '$.githubWait.since') IS NOT json_extract(OLD.state_json, '$.githubWait.since') BEGIN
  INSERT INTO feed_add VALUES ('run.waiting_github', NEW.id, NULL,
    'Waiting for GitHub: ' || NEW.title,
    json_extract(NEW.state_json, '$.githubWait.reason'),
    json_object('since', json_extract(NEW.state_json, '$.githubWait.since')),
    NEW.id || ':' || json_extract(NEW.state_json, '$.githubWait.since'));
END;
