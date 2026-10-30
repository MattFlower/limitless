import type { Run, StageName } from "../../src/core/types.ts";

/** Stages in the order the engine runs them; optional ones run only for some profiles or requests. */
const STATIONS = [
  { stage: "prepare" },
  { stage: "triage" },
  { stage: "clarify", optional: true },
  { stage: "spec" },
  { stage: "plan", optional: true },
  { stage: "holdout", optional: true },
  { stage: "implement" },
  { stage: "gates" },
  { stage: "audit" },
  { stage: "review" },
  { stage: "preview", optional: true },
  { stage: "verify" },
  { stage: "deliver" },
] as const satisfies readonly { stage: StageName; optional?: true }[];

// A new StageName other than engine-only acceptance must get a station before this can typecheck.
export const PIPELINE: readonly { stage: StageName; optional?: true }[] &
  (Exclude<StageName, "accept" | (typeof STATIONS)[number]["stage"]> extends never ? unknown : never) =
  STATIONS;

export interface PipelineCounts {
  queued: number;
  /** `waiting`: queued until the runs it depends on have merged. */
  blocked: number;
  /** Active runs (running or waiting on an answer) at each stage. */
  active: Partial<Record<StageName, number>>;
  /** The subset of `active` that is waiting on the owner's answer. */
  asking: Partial<Record<StageName, number>>;
}

export function pipelineCounts(runs: readonly Run[]): PipelineCounts {
  const counts: PipelineCounts = { queued: 0, blocked: 0, active: {}, asking: {} };
  for (const run of runs) {
    if (run.status === "queued") counts.queued++;
    else if (run.status === "waiting") counts.blocked++;
    else if (run.status === "running" || run.status === "waiting_input") {
      // A run that has started but not yet recorded its first stage is preparing.
      const stage = run.stage ?? "prepare";
      counts.active[stage] = (counts.active[stage] ?? 0) + 1;
      if (run.status === "waiting_input") counts.asking[stage] = (counts.asking[stage] ?? 0) + 1;
    }
  }
  return counts;
}
