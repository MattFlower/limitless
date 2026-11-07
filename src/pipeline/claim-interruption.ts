import { TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { githubWait } from "../git/github-wait.ts";
import { ClaimLostError, type ClaimWaitError } from "../integrations/claim-errors.ts";
import { finalizeRecordedCancellation } from "./cancellation.ts";
import { type Checkpointer, initialRunState, localCheckpointer, type RunState } from "./context.ts";

/** Stop execution, deferring ordinary shared cancellation but keeping confirmed loss local. */
export function mapClaimInterruption(
  store: Store,
  runId: string,
  error: ClaimWaitError | ClaimLostError,
  now = Date.now(),
  checkpointer: Checkpointer = localCheckpointer(store),
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
    const cancelled = finalizeRecordedCancellation(
      store,
      runId,
      lost ? localCheckpointer(store) : checkpointer,
    );
    const run = store.getRun(runId);
    if (!run || TERMINAL_STATUSES.includes(run.status)) return;
    const state = store.getRunState<Partial<RunState>>(runId) ?? initialRunState(run);
    if (cancelled) {
      // A deferred cancellation keeps its publication wait and retries only after the interval.
      if (error instanceof ClaimLostError || !state.githubWait) return;
      const reason = error.reason === "checkpoint" ? "claim:checkpoint" : state.githubWait.reason;
      state.githubWait = { ...state.githubWait, reason, nextAttemptAt: now + githubWait.intervalMs };
      store.updateRun(runId, {}, state);
      return;
    }
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
