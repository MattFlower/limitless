import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SIDECAR_BUILD = "7405d9f0555a61526a657992f1fe972bfeafed37";

/** Verify historical boots against application history, never against a run's checkout. */
export function legacySidecarStarts(db: Database): void {
  db.exec("CREATE TEMP TABLE legacy_sidecar_starts (ts INTEGER NOT NULL)");
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feed'").get()) return;
  // Pruned history cannot establish the first recording release's start.
  if (
    db.query("SELECT 1 FROM settings WHERE key = 'feed_pruned_through' AND CAST(value AS INTEGER) > 0").get()
  )
    return;
  const starts = db
    .query<{ ts: number; data: string }, []>(
      "SELECT ts, data FROM feed WHERE kind = 'daemon.started' ORDER BY ts",
    )
    .all();
  for (const start of starts) {
    try {
      const data: unknown = JSON.parse(start.data);
      if (!data || typeof data !== "object" || !("sha" in data)) continue;
      const { sha } = data;
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) continue;
      // This commit introduced recordWorktree; commit identity alone supplies no time boundary.
      if (sha !== SIDECAR_BUILD)
        execFileSync("git", ["--no-replace-objects", "merge-base", "--is-ancestor", SIDECAR_BUILD, sha], {
          cwd: join(import.meta.dir, "../.."),
          stdio: "ignore",
        });
      db.query("INSERT INTO legacy_sidecar_starts VALUES (?)").run(start.ts);
      break;
    } catch {
      // Unknown builds, malformed records and unavailable history cannot grant trust.
    }
  }
}
