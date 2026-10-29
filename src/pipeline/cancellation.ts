import type { Store } from "../db/store.ts";
import { type Checkpointer, localCheckpointer, type RunState } from "./context.ts";

export function clearGitHubWait(state: RunState | null): RunState | undefined {
  if (state) state.githubWait = undefined;
  return state ?? undefined;
}

/** Re-read the durable cancel mark before an execution can resume or release its slot. */
export function finalizeRecordedCancellation(
  store: Store,
  runId: string,
  checkpointer: Checkpointer = localCheckpointer(store),
): boolean {
  const run = store.getRun(runId);
  if (!run?.error?.startsWith("cancelled by")) return false;
  const state = store.getRunState<RunState>(runId);
  if (run.status !== "cancelled" || run.finishedAt === null || state?.githubWait)
    checkpointer.writeRun(
      runId,
      { status: "cancelled", finishedAt: run.finishedAt ?? Date.now() },
      clearGitHubWait(state),
    );
  return true;
}
