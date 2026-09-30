import { redactHoldoutText } from "./prompts.ts";
import { type Holdout, requirementCitationIssue, type Spec, type Verify } from "./schemas.ts";

export function preDeliveryVerifyArtifact(
  verify: Verify & { modelId: string; round: number; attempt: number },
  spec: Spec,
  holdout: Holdout,
  publicSources: string,
): string {
  const publicIds = new Set(spec.acceptance_criteria.map((criterion) => criterion.id));
  const redact = (value: string) => redactHoldoutText(value, holdout, publicSources);
  return JSON.stringify(
    {
      ...verify,
      notes: redact(verify.notes),
      criteria: verify.criteria.map((criterion) =>
        publicIds.has(criterion.id)
          ? criterion
          : {
              id: criterion.id,
              status: criterion.status,
              evidence: redact(criterion.evidence),
              publicSummary: redact(criterion.publicSummary.trim()),
              requirement: criterion.requirement ?? null,
              requirementCitation: redact(criterion.requirementCitation ?? ""),
            },
      ),
    },
    null,
    2,
  );
}

/**
 * The verifier's own statuses are authoritative, including `blocked` (a check that could not run
 * because of the environment). Inferring blocks from command output proved brittle: wrappers,
 * pipes and test filters kept defeating it. A wrong `blocked` costs one extra verify attempt or an
 * early stop with the evidence attached, never a silently wrong verdict.
 */
export function normalizeVerify(verify: Verify, spec: Spec, holdout: Holdout, request = ""): Verify {
  const scenarioIds = new Set(holdout.scenarios.map((s) => s.id));
  // A classification only means something on an unmet holdout; anywhere else it is dropped.
  const criteria = verify.criteria.map((c) =>
    c.status === "unmet" && scenarioIds.has(c.id)
      ? { ...c, requirement: c.requirement ?? null, requirementCitation: c.requirementCitation ?? "" }
      : { ...c, requirement: null, requirementCitation: "" },
  );
  for (const id of [...spec.acceptance_criteria.map((ac) => ac.id), ...scenarioIds]) {
    if (!criteria.some((c) => c.id === id))
      criteria.push({
        id,
        status: "unclear",
        evidence: "The verifier did not report on this criterion.",
        publicSummary: "",
        requirement: null,
        requirementCitation: "",
      });
  }
  const unique = new Set(criteria.map((c) => c.id)).size === criteria.length;
  let notes = verify.notes;
  for (const c of criteria) {
    if (c.status !== "unmet" || !scenarioIds.has(c.id)) continue;
    const issue = requirementCitationIssue(c, request, spec);
    const diagnostic = `${c.id}: requirement citation validation failed: ${issue}.`;
    if (issue && !notes.includes(diagnostic)) notes = [notes, diagnostic].filter(Boolean).join("\n");
  }
  return {
    ...verify,
    criteria,
    notes,
    overall: unique && criteria.every((c) => c.status === "met" || notRequired(c)) ? "pass" : "fail",
  };
}

/**
 * An unmet holdout whose expectation neither the request nor the spec implies: a follow-up note,
 * not a reason for another implement round. Unclassified results (recorded before classification
 * existed) keep blocking.
 */
export function notRequired(criterion: Verify["criteria"][number]): boolean {
  return criterion.status === "unmet" && criterion.requirement === "not_required";
}

/** Only environment blocks stand between this verify and a pass: another implement round can't help. */
export function blockedOnly(verify: Verify): boolean {
  return (
    verify.criteria.some((c) => c.status === "blocked") &&
    verify.criteria.every((c) => c.status === "met" || c.status === "blocked" || notRequired(c))
  );
}

export const ENVIRONMENT_BLOCKED = "verification blocked by the environment";
