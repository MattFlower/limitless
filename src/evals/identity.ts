import type { EvalTrial } from "../core/types.ts";
import { selectHarness } from "../harness/select.ts";
import {
  FACTORY_PREAMBLE,
  implementPrompt,
  reviewPrompt,
  triagePrompt,
  verifyPrompt,
} from "../pipeline/prompts.ts";
import { panelIdentity } from "../pipeline/review.ts";
import { toStrictJsonSchema } from "../pipeline/schemas.ts";
import type { Router } from "../router/router.ts";
import { recordedTarget } from "../router/targets.ts";
import { type EvalCase, hiddenContents } from "./cases.ts";
import { schemaFor, seedContent } from "./prepare.ts";

/** Named hashes of what an eval's cache keys depend on besides repository contents. */
export type EvalIdentity = Record<string, string>;
type EvalRole = "triage" | "review" | "verify" | "implement";

const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

/** Each role's prompt template rendered from fixed inputs, so a template edit changes its hash. */
function promptTemplate(role: EvalRole) {
  const base = { prompt: "", spec: null, baseSha: "BASE" };
  if (role === "triage") return triagePrompt({ repoSlug: "REPO", prompt: "", tree: "" });
  if (role === "review")
    return reviewPrompt({ ...base, stat: "", gates: [], audit: [], implementerReport: "" });
  if (role === "verify")
    return verifyPrompt({
      ...base,
      spec: {
        summary: "",
        assumptions: [],
        requirements: [],
        acceptance_criteria: [],
        out_of_scope: [],
        blocking_questions: [],
      },
      holdout: { scenarios: [] },
    });
  return implementPrompt({
    ...base,
    gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
    baseline: null,
    round: 0,
    feedback: null,
    hasHoldout: false,
  });
}

/**
 * Computed at submission and stored with the request, so `eval resume` can name what changed
 * (prompt template, preamble, panel policy, a case, a target's model or harness) since the eval ran.
 */
export function evalIdentity(
  role: EvalRole,
  cases: EvalCase[],
  casePath: string,
  trials: EvalTrial[],
  router: Router,
  panel: boolean,
): EvalIdentity {
  const identity: EvalIdentity = {
    preamble: hash(FACTORY_PREAMBLE),
    prompt: hash(promptTemplate(role)),
    ...(panel ? { panel: panelIdentity() } : {}),
  };
  for (const item of cases)
    identity[`case ${item.id}`] = hash([
      item,
      "hidden" in item
        ? hiddenContents(item, casePath)
        : [toStrictJsonSchema(schemaFor(item)), "defects" in item ? seedContent(item, casePath) : null],
    ]);
  for (const trial of trials) {
    const model = router.model(trial.modelId);
    const effort = trial.effort === null || trial.effort === "default" ? null : trial.effort;
    const target =
      model && (effort === null || model.supportedEfforts.includes(effort))
        ? router.toTarget(model, effort)
        : null;
    // The backend model and provider, not just the catalog ID: a new checkpoint behind an ID is a change.
    identity[`target ${recordedTarget(trial)}`] = hash(
      target
        ? [target.modelId, target.provider, target.model, selectHarness(role, target).harnessName]
        : null,
    );
  }
  return identity;
}

/** The parts of `before` that differ in `after`, including parts only one of them has. */
export function changedIdentity(before: EvalIdentity, after: EvalIdentity): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) => before[name] !== after[name],
  );
}
