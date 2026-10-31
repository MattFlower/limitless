export type ClaimWaitReason = "cancelled" | "lease" | "unavailable";

export abstract class ClaimControlError extends Error {
  protected constructor(message: string) {
    super(message);
  }
}

export class ClaimWaitError extends ClaimControlError {
  readonly reason: ClaimWaitReason;
  constructor(reason: ClaimWaitReason) {
    super(`Claim wait: ${reason}`);
    this.name = "ClaimWaitError";
    this.reason = reason;
  }
}

export class ClaimLostError extends ClaimControlError {
  constructor() {
    super("Claim lost");
    this.name = "ClaimLostError";
  }
}

export function rethrowClaimControl(error: unknown): void {
  if (error instanceof ClaimControlError) throw error;
}

/** Preserve the original control object; loss dominates wait, then input order breaks ties. */
export function selectClaimControl(reasons: readonly unknown[]): ClaimControlError | undefined {
  return (
    (reasons.find((error) => error instanceof ClaimLostError) as ClaimLostError | undefined) ??
    (reasons.find((error) => error instanceof ClaimWaitError) as ClaimWaitError | undefined)
  );
}
