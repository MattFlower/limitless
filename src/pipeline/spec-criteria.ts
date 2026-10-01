import type { Spec } from "./schemas.ts";

// Deliberately bounded list of out-of-run dependencies, matched as whole words/phrases:
// manual, human, owner, orchestrator, reviewer approves, in a browser, visually,
// screenshot, deploy, production, live API, after merge, wait for.
const outOfRun =
  /\b(?:manual|human|owner|orchestrator|reviewer\s+approves|in\s+a\s+browser|visually|screenshot|deploy|production|live\s+API|after\s+merge|wait\s+for)\b/i;

export function outOfRunCriteria(spec: Spec): Spec["acceptance_criteria"] {
  return spec.acceptance_criteria.filter((a) => outOfRun.test(a.criterion) || outOfRun.test(a.how_to_verify));
}
