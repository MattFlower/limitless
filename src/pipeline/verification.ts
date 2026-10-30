import type { RunEvent } from "../core/types.ts";
import { redactGateData, redactGateOutput } from "../gates/output.ts";
import { BROWSER_TOOLS } from "../harness/browser-mcp.ts";
import { promptJson, redactHoldoutText } from "./prompts.ts";
import { type Holdout, requirementCitationIssue, rowKind, type Spec, type Verify } from "./schemas.ts";

export type BrowserContext = "available" | "unavailable" | "no_preview";
export const BROWSER_INCOMPLETE =
  "Factory: a ready preview and browser were available for this attempt, but browser verification was not completed.";
export const browserToolNames = new Set(
  BROWSER_TOOLS.flatMap((name) => [`playwright.${name}`, `mcp__playwright__${name}`]),
);

export function browserSucceeded(events: RunEvent[]): boolean {
  const calls = new Set<string>();
  for (const event of events) {
    const data = event.data as { id?: unknown; toolUseId?: unknown; browserTool?: string } | null;
    const id = data?.toolUseId ?? data?.id;
    if (typeof id !== "string") continue;
    if (event.type === "tool_call") {
      if (browserToolNames.has(data?.browserTool ?? event.message)) calls.add(id);
      else calls.delete(id);
    }
    // onAgentEvent records successful results at debug level and failed results at warn level.
    if (event.type === "tool_result" && event.level === "debug" && calls.has(id)) return true;
  }
  return false;
}

export function applyBrowserContext(
  verify: Verify,
  spec: Spec,
  holdout: Holdout,
  context?: BrowserContext,
): Verify {
  if (context !== "available") return verify;
  const marked = new Set(
    [...spec.acceptance_criteria, ...holdout.scenarios].filter((c) => c.browser === true).map((c) => c.id),
  );
  return {
    ...verify,
    criteria: verify.criteria.map((c) => {
      if (c.status !== "blocked" || !marked.has(c.id)) return c;
      const { gateEvidence: _gate, ...row } = c;
      return {
        ...row,
        status: "unclear",
        blockedReason: null,
        covering_tests: [],
        evidence: `${BROWSER_INCOMPLETE}\n${redactGateOutput(c.evidence)}`,
        publicSummary: rowKind(c.id, spec, holdout) === "holdout" ? BROWSER_INCOMPLETE : c.publicSummary,
      };
    }),
  };
}

export function preDeliveryVerifyArtifact(
  verify: Verify & { modelId: string; round: number; attempt: number; sha?: string; modelOutput?: Verify },
  spec: Spec,
  holdout: Holdout,
  publicSources: string,
): string {
  const { modelOutput: _privateOutput, ...published } = verify;
  const redact = (value: string, id: string) =>
    rowKind(id, spec, holdout) === "unknown" ? "" : redactHoldoutText(value, holdout, publicSources);
  const gateCitation = (criterion: Verify["criteria"][number]) =>
    criterion.gateEvidence
      ? {
          gateEvidence: {
            stageId: criterion.gateEvidence.stageId,
            sha: criterion.gateEvidence.sha,
            check: redact(criterion.gateEvidence.check, criterion.id),
            command: redact(criterion.gateEvidence.command, criterion.id),
          },
        }
      : {};
  const evidence = (criterion: Verify["criteria"][number], publicRow = false) => {
    if (rowKind(criterion.id, spec, holdout) === "unknown") return "";
    const gate = criterion.gateEvidence;
    // Rebuild factory evidence so redacting private commands cannot remove the SHA or stage ID.
    return gate
      ? `Factory gate ${redact(gate.check, criterion.id)} passed at ${gate.sha} (stage ${gate.stageId}); commands: ${redact(gate.command, criterion.id)}`
      : redactHoldoutText(criterion.evidence, holdout, publicSources, !publicRow);
  };
  return promptJson(
    {
      ...published,
      notes: redactHoldoutText(verify.notes, holdout, publicSources),
      criteria: verify.criteria.map((criterion, index) =>
        rowKind(criterion.id, spec, holdout) === "public"
          ? {
              ...criterion,
              covering_tests: criterion.covering_tests?.map((t) => ({
                file: redact(t.file, criterion.id),
                name: redact(t.name, criterion.id),
              })),
              evidence: evidence(criterion, true),
              publicSummary: redactHoldoutText(criterion.publicSummary, holdout, publicSources, false),
              ...gateCitation(criterion),
            }
          : {
              id: rowKind(criterion.id, spec, holdout) === "unknown" ? `unknown-${index + 1}` : criterion.id,
              status: criterion.status,
              evidence: evidence(criterion),
              publicSummary: redact(criterion.publicSummary.trim(), criterion.id),
              requirement: criterion.requirement ?? null,
              requirementCitation: redact(criterion.requirementCitation ?? "", criterion.id),
              ...gateCitation(criterion),
            },
      ),
    },
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
  // Ground citations in the public text the verifier received, keeping stored identities literal.
  const publicRequest = redactGateOutput(request);
  const publicSpec = redactGateData(spec);
  for (const c of criteria) {
    if (c.status !== "unmet" || !scenarioIds.has(c.id)) continue;
    const issue = requirementCitationIssue(c, publicRequest, publicSpec);
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
