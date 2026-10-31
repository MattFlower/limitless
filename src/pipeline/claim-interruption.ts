import { TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { githubWait } from "../git/github-wait.ts";
import { ClaimLostError, type ClaimWaitError } from "../integrations/claim-errors.ts";
import { finalizeRecordedCancellation } from "./cancellation.ts";
import { localCheckpointer, type RunState } from "./context.ts";

/** Stop this execution locally, without publishing a shared cancellation or checkpoint. */
export function mapClaimInterruption(
  store: Store,
  runId: string,
  error: ClaimWaitError | ClaimLostError,
  now = Date.now(),
): void {
  store.transaction(() => {
    const lost = error instanceof ClaimLostError;
    for (const invocation of store.listInvocations(runId))
      if (invocation.status === "running")
        store.updateInvocation(invocation.id, {
          status: "cancelled",
          error: lost ? "interrupted: claim lost" : "interrupted: claim wait",
          finishedAt: now,
        });
    if (finalizeRecordedCancellation(store, runId, localCheckpointer(store))) return;
    const run = store.getRun(runId);
    if (!run || TERMINAL_STATUSES.includes(run.status)) return;
    const state = store.getRunState<Partial<RunState>>(runId) ?? {};
    state.githubWait = lost
      ? undefined
      : {
          since: state.githubWait?.since ?? now,
          nextAttemptAt: now + githubWait.intervalMs,
          reason: `claim:${error.reason}`,
        };
    store.updateRun(
      runId,
      {
        status: lost ? "cancelled" : "queued",
        stage: null,
        error: lost ? "superseded: claim lost" : null,
        finishedAt: lost ? now : null,
      },
      state,
    );
  });
}
