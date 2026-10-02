import type { Complexity } from "../core/types.ts";
import type { Spec } from "./schemas.ts";

export function specCriteriaRange(complexity?: Complexity): readonly [number, number] {
  switch (complexity) {
    case "trivial":
      return [1, 2];
    case "small":
      return [1, 3];
    case "medium":
      return [3, 5];
    case "large":
      return [5, 8];
    default:
      return [2, 8];
  }
}

// Deliberately bounded list, including common inflections, matched as whole words/phrases:
// manual, human, owner, orchestrator, reviewer approves, in a browser, visually,
// screenshot, deploy, production, live API, after merge, wait for.
const outOfRun =
  /\b(?:manual(?:ly)?|humans?|owners?|orchestrator|reviewer\s+approves|in\s+a\s+browser|visually|screenshots?|deploy(?:s|ed|ing|ments?)?|production|live\s+API|after\s+merge|wait\s+for)\b/i;

/**
 * Criteria whose verification seems to need something outside the run. Only `how_to_verify` is
 * checked: a criterion may name such features ("the deploy's active list empties"), and these
 * words are part of some repositories' own vocabulary, so a match only asks for one rewrite.
 */
export function outOfRunCriteria(spec: Spec): Spec["acceptance_criteria"] {
  return spec.acceptance_criteria.filter((a) => outOfRun.test(a.how_to_verify));
}
