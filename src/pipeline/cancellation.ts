import type { Store } from "../db/store.ts";
import type { RunState } from "./context.ts";

export function clearGitHubWait(state: RunState | null): RunState | undefined {
  if (state) state.githubWait = undefined;
  return state ?? undefined;
}

/** Re-read the durable cancel mark before an execution can resume or release its slot. */
export function finalizeRecordedCancellation(store: Store, runId: string): boolean {
  const run = store.getRun(runId);
  if (!run?.error?.startsWith("cancelled by")) return false;
  const state = store.getRunState<RunState>(runId);
  if (run.status !== "cancelled" || run.finishedAt === null || state?.githubWait)
    store.updateRun(
      runId,
      { status: "cancelled", finishedAt: run.finishedAt ?? Date.now() },
      clearGitHubWait(state),
    );
  return true;
}
