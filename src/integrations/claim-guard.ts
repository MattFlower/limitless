import { AsyncLocalStorage } from "node:async_hooks";
import { ClaimLostError, ClaimWaitError, rethrowClaimControl } from "./claim-errors.ts";
import type { ClaimTip } from "./claim-ref.ts";
import type { LeaseHandle, LeaseManager } from "./leases.ts";

export interface ScopedClaim {
  readonly handle: LeaseHandle;
  readonly lost: boolean;
  cancelled(): boolean;
  windowOpen(): boolean;
  onLost(h: LeaseHandle, tip: ClaimTip | null): void;
}

export function bindClaim(
  leases: Pick<LeaseManager, "windowOpen">,
  handle: LeaseHandle,
  cancelled: () => boolean,
): ScopedClaim {
  const { repo, ref, run, member, generation } = handle;
  const captured = Object.freeze({ repo, ref, run, member, generation });
  let lost = false;
  return Object.freeze({
    handle: captured,
    get lost() {
      return lost;
    },
    cancelled: () => cancelled(),
    windowOpen: () => leases.windowOpen(captured),
    onLost(h: LeaseHandle, _tip: ClaimTip | null) {
      if (
        h.repo.toLowerCase() === repo.toLowerCase() &&
        h.ref === ref &&
        h.run === run &&
        h.member === member &&
        h.generation === generation
      )
        lost = true;
    },
  });
}

const scope = new AsyncLocalStorage<readonly ScopedClaim[]>();
export function hasClaimScope(): boolean {
  return !!scope.getStore()?.length;
}

export const claimScope = {
  run<T>(claims: readonly ScopedClaim[], fn: () => T): T {
    return scope.run(Object.freeze([...(scope.getStore() ?? []), ...claims]), fn);
  },
  exit<T>(fn: () => T): T {
    return scope.exit(fn);
  },
};

export function claimGuard(): void {
  const claims = scope.getStore();
  if (!claims?.length) return;
  if (claims.some((claim) => claim.lost)) throw new ClaimLostError();
  for (const stage of ["cancelled", "windowOpen"] as const) {
    let unavailable = false;
    let blocked = false;
    for (const claim of claims) {
      try {
        const result = claim[stage]();
        if (typeof result !== "boolean") unavailable = true;
        else if (result === (stage === "cancelled")) blocked = true;
      } catch (error) {
        rethrowClaimControl(error);
        unavailable = true;
      }
    }
    if (stage === "cancelled" && blocked) throw new ClaimWaitError("cancelled");
    if (unavailable) throw new ClaimWaitError("unavailable");
    if (blocked) throw new ClaimWaitError("lease");
  }
}
