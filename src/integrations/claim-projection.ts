import type { Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";

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
