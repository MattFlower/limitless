import { type Run, TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { ClaimLostError, ClaimWaitError, rethrowClaimControl } from "../integrations/claim-errors.ts";
import { claimGuard, claimScope, type ScopedClaim } from "../integrations/claim-guard.ts";
import { canonicalRepo } from "../integrations/lease-store.ts";
import type { LeaseManager } from "../integrations/leases.ts";
import { claimKey, claimRef } from "./portable.ts";

/** Binding and updater must come from the same manager. */
export type RunClaim = Readonly<{
  binding: ScopedClaim;
  leases: Pick<LeaseManager, "update">;
}>;

export function validateRunClaim(run: Run, store: Store, authority: RunClaim | null | undefined): RunClaim {
  try {
    if (!authority) throw new ClaimWaitError("unavailable");
    const { handle } = authority.binding;
    const key = claimKey(run, store);
    const repo = canonicalRepo(run.repoSlug);
    if (
      "none" in key ||
      handle.run !== run.id ||
      canonicalRepo(handle.repo) !== repo ||
      canonicalRepo(key.repo) !== repo ||
      handle.ref !== claimRef(key)
    )
      throw new ClaimWaitError("unavailable");
    return authority;
  } catch (error) {
    rethrowClaimControl(error);
    throw new ClaimWaitError("unavailable");
  }
}

/** Supply fresh per-execution dependencies; never mutate scheduler-wide dependencies. */
export function bindRunClaim(run: Run, store: Store, authority: RunClaim | null | undefined): RunClaim {
  const { binding, leases } = validateRunClaim(run, store, authority);
  const runId = run.id;
  return Object.freeze({
    leases,
    binding: Object.freeze({
      handle: binding.handle,
      get lost() {
        return binding.lost;
      },
      windowOpen: () => binding.windowOpen(),
      onLost: (h, tip) => binding.onLost(h, tip),
      cancelled() {
        try {
          const current = store.getRun(runId);
          if (!current) throw new ClaimWaitError("unavailable");
          if (current.error?.startsWith("cancelled by") || TERMINAL_STATUSES.includes(current.status))
            return true;
          return binding.cancelled();
        } catch (error) {
          rethrowClaimControl(error);
          throw new ClaimWaitError("unavailable");
        }
      },
    } satisfies ScopedClaim),
  });
}

/** Required anew before each start/restart; persisted held state grants no permission. */
export async function renewRunClaim({ binding, leases }: RunClaim): Promise<void> {
  try {
    if (binding.lost) throw new ClaimLostError();
    const result = await leases.update(binding.handle, {});
    if (result === "applied") {
      // Add our captured binding without discarding inherited scopes.
      claimScope.run([binding], claimGuard);
      return;
    }
    if (result === "lost" || result === "obsolete") binding.onLost(binding.handle, null);
    if (binding.lost || result === "lost" || result === "obsolete") throw new ClaimLostError();
    throw new ClaimWaitError("lease");
  } catch (error) {
    rethrowClaimControl(error);
    throw new ClaimWaitError("unavailable");
  }
}
