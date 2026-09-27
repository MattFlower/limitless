// Terminal fixtures only: a normal daemon must never schedule these runs.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newId, Store } from "../src/db/store.ts";

const home = process.env.LIMITLESS_HOME;
const configDir = process.env.LIMITLESS_CONFIG_DIR;
if (!home || !configDir) throw new Error("Preview seed requires LIMITLESS_HOME and LIMITLESS_CONFIG_DIR");
mkdirSync(home, { recursive: true });
const store = new Store(join(home, "limitless.db"));
try {
  const repo = store.upsertRepo({
    slug: "local/preview",
    kind: "local",
    url: null,
    localPath: process.cwd(),
    defaultBranch: "main",
    mergePolicy: "none",
  });
  // Reuse seed-demo.ts's SSE telemetry scenario, with multiline acceptance criteria.
  const longPrompt = `The run detail stream should log a rate_limit-style breadcrumb whenever the browser reconnects,
so we can see flaky-network runs in the event log instead of just a gap in timestamps.

Acceptance criteria:
- Record a reconnect event with a timestamp and the run identifier after a dropped connection.
- Keep the existing event log readable while a run produces several consecutive reconnects.
- Preserve multiline prompts and long request text without clipping the run detail controls.
- Show a useful empty state when the request contains only whitespace.
- Verify that short prompts remain compact in both the run list and the run detail view.`;
  const rows = [
    ["Add per-run SSE reconnect telemetry", longPrompt, "succeeded"],
    ["Short prompt", "Fix spacing", "needs_human"],
    ["Whitespace prompt", " \n\t  ", "failed"],
  ] as const;
  // Like seed-demo.ts, insert statuses directly so even an intermediate queued row cannot be observed.
  const insert = store.db.query(
    `INSERT INTO runs (id, repo_id, title, prompt, source, profile, status, created_at, finished_at)
     VALUES (?, ?, ?, ?, 'ui', 'standard', ?, ?, ?)`,
  );
  for (const [title, prompt, status] of rows)
    insert.run(newId(), repo.id, title, prompt, status, Date.now(), Date.now());
} finally {
  store.close();
}
