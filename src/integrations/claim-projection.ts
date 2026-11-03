import { type Config, repoSettings } from "../config.ts";
import type { Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { type ClaimKey, claimKey, claimRef } from "../pipeline/portable.ts";
import { bindRunClaim, type RunClaim, sharedRepository, validateRunClaim } from "../pipeline/run-claim.ts";
import { ClaimWaitError, rethrowClaimControl } from "./claim-errors.ts";
import { claimGuard, claimScope, type ScopedClaim } from "./claim-guard.ts";
import { canonicalRepo } from "./lease-store.ts";

export type ObserverAuthority = (key: ClaimKey) => RunClaim | null | undefined;

export function observerClaimGuard(
  store: Store,
  cfg: Pick<Config, "repos">,
  run: Pick<Run, "id" | "repoSlug"> | { pr: { repo: string; number: number } },
  authority?: ObserverAuthority,
): () => void {
  return () => {
    if (!("pr" in run) && repoSettings(cfg, run.repoSlug).shared !== true)
      return observerDispatchGuard(store, run.id)();
    try {
      if ("pr" in run) {
        const { repo: slug, number } = run.pr;
        if (repoSettings(cfg, slug).shared !== true) return;
        const repo = store.getRepoBySlug(slug);
        if (!repo) throw new ClaimWaitError("unavailable");
        if (!sharedRepository(cfg, repo, slug)) return;
        const key = { kind: "pr", repo: canonicalRepo(slug), number } as const;
        const a = authority?.(key);
        if (!a) throw new ClaimWaitError("unavailable");
        const holder = store.getRun(a.binding.handle.run);
        if (!holder) throw new ClaimWaitError("unavailable");
        if (isClaimLossProjection(holder)) throw new ClaimObserverSuppressed();
        const { binding } = bindRunClaim(holder, store, a);
        if (binding.handle.ref !== claimRef(key) || canonicalRepo(binding.handle.repo) !== key.repo)
          throw new ClaimWaitError("unavailable");
        return claimScope.run([binding], claimGuard);
      }
      const repo = store.getRepoBySlug(run.repoSlug);
      if (!repo) throw new ClaimWaitError("unavailable");
      if (!sharedRepository(cfg, repo, run.repoSlug)) return observerDispatchGuard(store, run.id)();
      const current = store.getRun(run.id);
      if (!current) throw new ClaimWaitError("unavailable");
      observerDispatchGuard(store, run.id)();
      const key = claimKey(current, store);
      if ("none" in key) throw new ClaimWaitError("unavailable");
      const { binding } = validateRunClaim(current, store, authority?.(key));
      const view: ScopedClaim = {
        handle: binding.handle,
        get lost() {
          return binding.lost;
        },
        windowOpen: () => binding.windowOpen(),
        onLost: (h, tip) => binding.onLost(h, tip),
        cancelled: () => false,
      };
      claimScope.run([view], claimGuard);
    } catch (error) {
      if (error instanceof ClaimObserverSuppressed) throw error;
      rethrowClaimControl(error);
      throw new ClaimWaitError("unavailable");
    }
  };
}

export const isClaimLossProjection = (run: Pick<Run, "status" | "error"> | null) =>
  run?.status === "cancelled" && run.error === "superseded: claim lost";

export class ClaimObserverSuppressed extends Error {
  constructor() {
    super("Claim-loss observer suppressed");
    this.name = "ClaimObserverSuppressed";
  }
}

export function observerDispatchGuard(store: Store, runId: string, existingGuard?: () => void) {
  return () => {
    existingGuard?.();
    if (isClaimLossProjection(store.getRun(runId))) throw new ClaimObserverSuppressed();
  };
}
