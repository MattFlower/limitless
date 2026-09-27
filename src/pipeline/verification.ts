import type { Holdout, Spec, Verify } from "./schemas.ts";

/**
 * The verifier's own statuses are authoritative, including `blocked` (a check that could not run
 * because of the environment). Inferring blocks from command output proved brittle: wrappers,
 * pipes and test filters kept defeating it. A wrong `blocked` costs one extra verify attempt or an
 * early stop with the evidence attached, never a silently wrong verdict.
 */
export function normalizeVerify(verify: Verify, spec: Spec, holdout: Holdout): Verify {
  const criteria = [...verify.criteria];
  for (const id of [...spec.acceptance_criteria.map((ac) => ac.id), ...holdout.scenarios.map((s) => s.id)]) {
    if (!criteria.some((c) => c.id === id))
      criteria.push({
        id,
        status: "unclear",
        evidence: "The verifier did not report on this criterion.",
        publicSummary: "",
      });
  }
  const unique = new Set(criteria.map((c) => c.id)).size === criteria.length;
  return {
    ...verify,
    criteria,
    overall: unique && criteria.every((c) => c.status === "met") ? "pass" : "fail",
  };
}

/** Only environment blocks stand between this verify and a pass: another implement round can't help. */
export function blockedOnly(verify: Verify): boolean {
  return (
    verify.criteria.some((c) => c.status === "blocked") &&
    verify.criteria.every((c) => c.status === "met" || c.status === "blocked")
  );
}

export const ENVIRONMENT_BLOCKED = "verification blocked by the environment";
