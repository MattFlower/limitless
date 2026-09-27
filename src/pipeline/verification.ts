import type { CommandResult } from "../harness/types.ts";
import type { Holdout, Spec, Verify } from "./schemas.ts";

/** Only observed execution barriers count, not source quotations or expected denial tests. */
export function environmentBarrier(evidence: string): boolean {
  const denial =
    /\b(?:EPERM|EACCES|permission denied|operation not permitted)\b|sandbox[^.\n]*(?:denied|denial|blocked)/i;
  const observed = /\b(?:ran|running|executed|attempted|failed|could not|cannot|unable|blocked|error)\b/i;
  const context =
    /\b(?:command|test|build|check|fixture|mkdir|mkdtemp|open|write|spawn|exec|bun|npm|pytest)\b/i;
  const expected =
    /\b(?:expected|assert(?:ion)?|quoted|documentation|source (?:code|text)|literal|matches|toThrow)\b/i;
  return (
    denial.test(evidence) && observed.test(evidence) && context.test(evidence) && !expected.test(evidence)
  );
}

function observedBarrier(result: CommandResult, evidence: string): boolean {
  if (!result.isError || /\b(?:expected|assertion|toThrow)\b/i.test(result.output)) return false;
  if (
    !/\b(?:EPERM|EACCES|permission denied|operation not permitted)\b|sandbox[^\n]*(?:denied|denial|blocked)/i.test(
      result.output,
    )
  )
    return false;
  // Reading source or printing a quoted diagnostic is not execution of a failed check.
  if (/(?:^|[;|&]\s*|\s-[cl]+\s+['"]?)(?:cat|rg|grep|sed|head|tail|echo|printf)\s/.test(result.command))
    return false;
  const command = result.command.replace(/^\/?(?:bin\/)?(?:ba|z)?sh\s+-[lc]+\s+['"]?/, "").trim();
  const executable = command
    .match(/^[\w./-]+/)?.[0]
    ?.split("/")
    .at(-1);
  return executable !== undefined && evidence.toLowerCase().includes(executable.toLowerCase());
}

export function normalizeVerify(
  verify: Verify,
  spec: Spec,
  holdout: Holdout,
  commands: CommandResult[] = [],
): Verify {
  const criteria = verify.criteria.map((c) => ({
    ...c,
    // A met criterion stays met: evidence may mention an EPERM the verifier worked around.
    status:
      (c.status === "unmet" || c.status === "unclear") &&
      environmentBarrier(c.evidence) &&
      commands.some((command) => observedBarrier(command, c.evidence))
        ? ("blocked" as const)
        : c.status,
  }));
  for (const id of [...spec.acceptance_criteria.map((ac) => ac.id), ...holdout.scenarios.map((s) => s.id)]) {
    if (!criteria.some((c) => c.id === id))
      criteria.push({ id, status: "unclear", evidence: "The verifier did not report on this criterion." });
  }
  const unique = new Set(criteria.map((c) => c.id)).size === criteria.length;
  return {
    ...verify,
    criteria,
    overall: unique && criteria.every((c) => c.status === "met") ? "pass" : "fail",
  };
}

export function blockedOnly(verify: Verify): boolean {
  return (
    verify.criteria.some((c) => c.status === "blocked") &&
    verify.criteria.every((c) => c.status === "met" || c.status === "blocked")
  );
}

export const ENVIRONMENT_BLOCKED = "verification blocked by the environment";
