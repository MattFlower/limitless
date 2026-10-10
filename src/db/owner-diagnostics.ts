import type { Database } from "bun:sqlite";

export interface OwnerDiagnostic {
  id: number;
  runId: string;
  invocationId: number | null;
  eventId: number | null;
  kind: "error" | "result" | "event" | "run-error";
  text: string;
}

/** Local owner lookup only: never include these rows in public objects or publications. */
export function ownerDiagnostics(db: Database, runId: string, after = 0): OwnerDiagnostic[] {
  // Older releases/databases have no private diagnostics.
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'owner_diagnostics'").get()) return [];
  return db
    .query<OwnerDiagnostic, [string, number]>(
      `SELECT id, run_id AS runId, invocation_id AS invocationId, event_id AS eventId, kind, text
       FROM owner_diagnostics WHERE run_id = ? AND id > ? ORDER BY id`,
    )
    .all(runId, after);
}
