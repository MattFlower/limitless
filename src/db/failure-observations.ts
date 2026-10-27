import {
  classifyObservation,
  type FailureClass,
  type FailureHistory,
  observationHistory,
} from "../gates/failure-class.ts";
import { redactGateOutput } from "../gates/output.ts";
import type { GateComparison } from "../gates/run.ts";
import type { Store } from "./store.ts";

export interface FailureObservation {
  id: number;
  run_id: string;
  repo: string;
  stage_id: number;
  round: number;
  sha: string;
  handle_kind: string;
  handle_id: string;
  phase: "setup" | "check";
  name: string;
  command: string;
  // Local only: D1a must map location to a placeholder before anything is published.
  location: string | null;
  os: string | null;
  load_per_core: number | null;
  observed_at: number;
  exit_code: number | null;
  timed_out: number;
  confinement: number;
  duration_ms: number;
  failed_files: string;
  output_tail: string;
  signature: string;
  setup_eligible: number;
  class: FailureClass | null;
  history: FailureHistory | null;
  finalized_at: number | null;
  interim: number;
}
export type ObservationFilter = { repo?: string; since?: number; class?: FailureClass; finalized?: boolean };
export class FailureObservations {
  constructor(private readonly store: Store) {}
  read(filter: ObservationFilter = {}): FailureObservation[] {
    return this.store.db
      .query<FailureObservation, (string | number | null)[]>(
        "SELECT * FROM failure_observations WHERE (? IS NULL OR repo=?) AND (? IS NULL OR observed_at>=?) AND (? IS NULL OR class=?) AND (? IS NULL OR (finalized_at IS NOT NULL)=?) ORDER BY id",
      )
      .all(
        filter.repo ?? null,
        filter.repo ?? null,
        filter.since ?? null,
        filter.since ?? null,
        filter.class ?? null,
        filter.class ?? null,
        filter.finalized === undefined ? null : Number(filter.finalized),
        Number(!!filter.finalized),
      );
  }
  insert(row: Omit<FailureObservation, "id" | "class" | "history" | "finalized_at" | "interim">): void {
    const columns = Object.keys(row);
    this.store.db
      .query(
        `INSERT INTO failure_observations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT DO NOTHING`,
      )
      .run(...Object.values(row));
    if (row.setup_eligible) this.promote();
  }
  finalize(
    runId: string,
    completion?: { round: number; sha: string; stageId: number; comparisons: GateComparison[] },
  ): void {
    const rows = this.store.db
      .query<FailureObservation, [string]>(
        "SELECT * FROM failure_observations WHERE run_id=? AND (finalized_at IS NULL OR interim=1)",
      )
      .all(runId);
    for (const row of rows) {
      if (completion && (row.round !== completion.round || row.sha !== completion.sha)) continue;
      if (!completion && row.finalized_at !== null) continue;
      const c = completion?.comparisons.find(
        (c) =>
          c.verdict !== "not_run" &&
          redactGateOutput(c.name) === row.name &&
          redactGateOutput(c.result.command) === row.command,
      );
      const history = completion ? observationHistory(c, row.stage_id !== completion.stageId) : "interrupted";
      const cls = classifyObservation({ ...row, history }, c);
      this.store.db
        .query("UPDATE failure_observations SET class=?,history=?,finalized_at=?,interim=? WHERE id=?")
        .run(cls, history, Date.now(), Number(!completion), row.id);
    }
    if (rows.some((r) => r.setup_eligible)) this.promote();
  }
  private promote(): void {
    this.store.db.exec(`UPDATE failure_observations AS a SET class='undeclared_requirement'
      WHERE a.class='setup' AND a.setup_eligible=1 AND a.finalized_at IS NOT NULL AND a.location IS NOT NULL
      AND EXISTS (SELECT 1 FROM failure_observations b WHERE b.setup_eligible=1 AND b.repo=a.repo
        AND b.signature=a.signature AND b.location IS NOT NULL AND b.location<>a.location
        AND b.observed_at BETWEEN a.observed_at-604800000 AND a.observed_at+604800000)`);
  }
}
