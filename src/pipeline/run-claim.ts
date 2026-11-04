import { type Config, repoSettings } from "../config.ts";
import { type Repo, type Run, TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { ClaimLostError, ClaimWaitError, rethrowClaimControl } from "../integrations/claim-errors.ts";
import { claimGuard, claimScope, type ScopedClaim } from "../integrations/claim-guard.ts";
import { canonicalRepo } from "../integrations/lease-store.ts";
import type { LeaseHandle, LeaseManager } from "../integrations/leases.ts";
import type { CapabilityGate } from "../integrations/member-eligibility.ts";
import type { RunState } from "./context.ts";
import { claimKey, claimRef } from "./portable.ts";

export const sharedRepository = (cfg: Pick<Config, "repos">, repo: Pick<Repo, "kind">, slug: string) =>
  repoSettings(cfg, slug).shared === true && repo.kind === "github";

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
export function bindRunClaim(
  run: Run,
  store: Store,
  authority: RunClaim | null | undefined,
  gate?: CapabilityGate,
): RunClaim {
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
      capable() {
        try {
          return gate?.capableNow(run.id) ?? false;
        } catch (error) {
          rethrowClaimControl(error);
          return false;
        }
      },
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

export const waitingForCapability = (store: Store, runId: string): boolean =>
  store.getRun(runId)?.status === "queued" &&
  store.getRunState<RunState>(runId)?.githubWait?.reason === "claim:capability";

export function withCapabilityLapse(store: Store, active: (h: LeaseHandle) => boolean) {
  return (h: LeaseHandle) => !waitingForCapability(store, h.run) && active(h);
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
