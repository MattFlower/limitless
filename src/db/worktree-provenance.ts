import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The #323 squash on main first introduced recordWorktree in deployed releases.
export const SIDECAR_BUILD = "50e74bfd1831592896d03da21b2c49fe1cfcc4e5";

/** Verify historical boots against application history, never against a run's checkout. */
function legacySidecarStart(db: Database): number | null {
  // Pruned history cannot establish the first recording release's start.
  if (
    db.query("SELECT 1 FROM settings WHERE key = 'feed_pruned_through' AND CAST(value AS INTEGER) > 0").get()
  )
    return null;
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
      execFileSync("git", ["--no-replace-objects", "merge-base", "--is-ancestor", SIDECAR_BUILD, sha], {
        cwd: join(import.meta.dir, "../.."),
        stdio: "ignore",
      });
      return start.ts;
    } catch {
      // Unknown builds, malformed records and unavailable history cannot grant trust.
    }
  }
  return null;
}

/** Retry after startup: the migration can precede the first persisted recording boot. */
export function markLegacyWorktree(db: Database, runId: string): void {
  const cutoff = legacySidecarStart(db);
  if (cutoff === null) return;
  db.query(`UPDATE runs SET worktree_provenance = 'legacy'
    WHERE id = ?1 AND worktree_provenance IS NULL
    AND (SELECT COUNT(*) FROM stages WHERE run_id = runs.id AND name = 'prepare') = 1
    AND NOT EXISTS (
      SELECT 1 FROM stages WHERE run_id = runs.id AND name = 'prepare'
        AND started_at >= ?2
    ) AND EXISTS (
      SELECT 1 FROM stages WHERE run_id = runs.id AND name = 'prepare'
        AND started_at < ?2
        AND ((status = 'succeeded' AND finished_at < ?2)
          OR EXISTS (SELECT 1 FROM events WHERE run_id = runs.id AND type = 'gate'
            AND ts >= stages.started_at
            AND ts <= COALESCE(stages.finished_at, ?2 - 1)
            AND ts < ?2))
    )`).run(runId, cutoff);
}
