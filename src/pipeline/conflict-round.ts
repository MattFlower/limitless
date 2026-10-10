import { prHeadProblem } from "../core/delivery.ts";
import type { Store } from "../db/store.ts";
import { type GhRunner, runGh } from "../integrations/github.ts";
import { readPrHead } from "./review-round.ts";

/** Pending inserts survive a shutdown before the round transaction. */
export async function processConflictTriggers(
  store: Store,
  now: () => number,
  gh: GhRunner = runGh,
  signal?: AbortSignal,
) {
  let lookupError: unknown;
  for (const trigger of store.pendingConflictTriggers()) {
    signal?.throwIfAborted();
    let pr: Awaited<ReturnType<typeof readPrHead>>;
    try {
      pr = await readPrHead(gh, trigger.prUrl, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      store.failConflictLookup(trigger.id, error);
      lookupError ??= error;
      continue;
    }
    signal?.throwIfAborted();
    const target = store.runForPr(trigger.prUrl);
    const owner = target && (store.reviewRound(target.id)?.owner ?? target);
    const repo = owner && store.getRepo(owner.repoId);
    store.startConflictTrigger(
      trigger.id,
      {
        state: pr.state,
        isDraft: pr.isDraft,
        headRefOid: pr.headSha,
        headRefName: pr.headBranch,
        isCrossRepository: pr.crossRepository,
        headRepository: { nameWithOwner: pr.headRepo },
        problem: repo && owner?.branch ? (prHeadProblem(repo, owner.branch, pr) ?? undefined) : undefined,
      },
      now(),
    );
  }
  if (lookupError) throw lookupError;
}
