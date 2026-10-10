import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { type OwnerDiagnostic, ownerDiagnostics } from "../db/owner-diagnostics.ts";

/** Read locally, never via the daemon: loopback HTTP does not establish owner identity. */
export function localOwnerDiagnostics(runId: string, after = 0): OwnerDiagnostic[] {
  const path = loadConfig({ readOnly: true }).paths.db;
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return ownerDiagnostics(db, runId, after);
  } finally {
    db.close();
  }
}

export function printOwnerDiagnostics(rows: OwnerDiagnostic[]): void {
  for (const row of rows) {
    const source = row.eventId
      ? `event #${row.eventId}`
      : row.invocationId
        ? `invocation #${row.invocationId}`
        : "run";
    console.log(`  [owner diagnostic: ${source} ${row.kind}]\n${row.text}`);
  }
}
