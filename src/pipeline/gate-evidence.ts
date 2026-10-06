import type { GateComparison } from "../gates/run.ts";
import { BunTestCoverage } from "../gates/test-coverage.ts";
import type { Holdout, Spec, Verify } from "./schemas.ts";

/** Factory provenance, saved with the completed candidate gate stage (never baseline checks). */
export interface GateEvidence {
  stageId: number;
  sha: string;
  checks: (GateComparison & { testCommand: string | null })[];
}

/** Only simple test commands are expanded; shell control flow cannot prove test coverage. */
export function gateTestCommand(command: string, scripts: Record<string, string>): string | null {
  const script = /^(?:bun|npm|pnpm) run ([\w:-]+)$/.exec(command.trim());
  const expanded = script ? scripts[script[1] ?? ""] : command.trim();
  return expanded && /^[\w./-]+(?: [\w./:=@-]+)*$/.test(expanded) ? expanded : null;
}

function covers(check: GateEvidence["checks"][number], instructions: string): boolean {
  const command = check.testCommand;
  if (!command) return false;
  if (/[;&|<>]/.test(instructions)) return false;
  const exact = instructions
    .trim()
    .replace(/^Run\s+/i, "")
    .replace(/^`|`\.?$/g, "");
  if (!command.startsWith("bun test")) {
    return exact === command && !/\b(?:skip(?:ped)?|todo)\b/i.test(check.result.output);
  }
  // File headers and passing rows prove that the broad suite actually discovered and ran the file.
  // A tail without its header, a skipped file, flags/filters and unsupported runners fail closed.
  const requestedCommand = exact === check.result.command ? command : instructions;
  const commands = requestedCommand.match(/\bbun test(?: [\w./-]+)*/g) ?? [];
  if (commands.length !== 1) return false;
  const requested =
    commands[0]
      ?.split(" ")
      .slice(2)
      .map((path) => path.replace(/^\.\//, "")) ?? [];
  const selected = command
    .split(" ")
    .slice(2)
    .map((path) => path.replace(/^\.\//, ""));
  if ([...requested, ...selected].some((arg) => arg.startsWith("-"))) return false;
  if ([...requested, ...selected].some((path) => path.startsWith("/") || path.split("/").includes("..")))
    return false;
  if (requested.some((file) => selected.length > 0 && !selected.some((filter) => file.includes(filter))))
    return false;
  if (
    requested.length > 0 &&
    selected.length === requested.length &&
    requested.every((file, index) => file === selected[index] && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
  )
    return (
      !check.result.testCoverage?.skippedFiles.length &&
      !/\((?:skip|todo|fail)\)|(?:^|\n)\s*(?:[1-9]\d* (?:skip|todo)|0 pass)\b/.test(check.result.output)
    );
  const recorded = new BunTestCoverage();
  for (const line of check.result.output.split(/\r?\n/)) recorded.observe(line);
  const coverage = check.result.testCoverage ?? recorded.result();
  const ran = coverage.passedFiles;
  if (!requested.length)
    return command === "bun test" && ran.length > 0 && coverage.skippedFiles.length === 0;
  return requested.every((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && ran.includes(file));
}

function passed(check: GateEvidence["checks"][number]): boolean {
  const clean = (result: GateComparison["result"]): boolean =>
    !result.confinementError &&
    !result.output.includes("sandbox_apply: Operation not permitted") &&
    (!result.firstAttempt || clean(result.firstAttempt));
  return (
    ["pass", "fixed", "new_pass", "flaky"].includes(check.verdict) &&
    !check.blocking &&
    check.result.ok &&
    check.result.exitCode === 0 &&
    !check.result.timedOut &&
    clean(check.result) &&
    (!check.firstAttempt || clean(check.firstAttempt))
  );
}

/** Model output supplies only `blocked`; provenance and coverage come from factory gate records. */
export function applyGateEvidence(
  verify: Verify,
  spec: Spec,
  holdout: Holdout,
  sha: string,
  gates?: GateEvidence,
): Verify {
  return {
    ...verify,
    criteria: verify.criteria.map((criterion) => {
      if (criterion.status === "unmet" || criterion.status === "unclear") return criterion;
      // Re-evaluate a previously substituted row on resume, including after a changed HEAD.
      const blocked = criterion.gateEvidence
        ? {
            ...criterion,
            status: "blocked" as const,
            evidence: criterion.gateEvidence.blockedEvidence,
            gateEvidence: undefined,
          }
        : criterion;
      if (blocked.status !== "blocked" || !gates || gates.sha !== sha || !/^[a-f\d]{40}$/i.test(sha))
        return blocked;
      const definitions = [
        ...spec.acceptance_criteria.filter((ac) => ac.id === blocked.id).map((ac) => ac.how_to_verify),
        ...holdout.scenarios
          .filter((scenario) => scenario.id === blocked.id)
          .map((scenario) => scenario.steps),
      ];
      if (definitions.length !== 1) return blocked;
      const check = gates.checks.find((check) => passed(check) && covers(check, definitions[0] ?? ""));
      if (!check) return blocked;
      const citation = `verified by gate run ${gates.stageId} on ${sha}; check ${check.name} (${check.result.command})`;
      return {
        ...blocked,
        status: "met" as const,
        evidence: `${blocked.evidence}\n${citation}`,
        gateEvidence: {
          stageId: gates.stageId,
          sha,
          check: check.name,
          command: check.result.command,
          blockedEvidence: blocked.evidence,
        },
      };
    }),
  };
}
