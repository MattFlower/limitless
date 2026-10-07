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

// Runner status rows and summaries, not words inside passing test names or diagnostic prose.
const incompleteTestOutput =
  /^\s*(?:\((?:skip|todo|fail)\)(?:\s|$)|(?:[1-9]\d* (?:skip(?:ped)?|todo|fail(?:ed)?|not run)|0 pass)\s*$|not run:\s)/im;

/** Each nonempty line must be a complete simple command; prose/inspections fail closed. */
function verificationCommands(instructions: string): string[] {
  return instructions
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^(?:[-*] |\d+[.)] )/, "")
        .replace(/^Run\s+/i, "")
        .replace(/^`([^`]+)`\.?$/, "$1"),
    )
    .filter(Boolean);
}

function covers(check: GateEvidence["checks"][number], requestedCommand: string): boolean {
  const command = check.testCommand;
  if (!command) return false;
  if (!command.startsWith("bun test")) {
    return requestedCommand === command || requestedCommand === check.result.command;
  }
  // File headers and passing rows prove that the broad suite actually discovered and ran the file.
  // A tail without its header, a skipped file, flags/filters and unsupported runners fail closed.
  const expanded = requestedCommand === check.result.command ? command : requestedCommand;
  if (!/^bun test(?: [\w./-]+)*$/.test(expanded)) return false;
  const requested = expanded
    .split(" ")
    .slice(2)
    .map((path) => path.replace(/^\.\//, ""));
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
    return !check.result.testCoverage?.skippedFiles.length && !incompleteTestOutput.test(check.result.output);
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
    result.ok &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.confinementError &&
    !result.output.includes("sandbox_apply: Operation not permitted") &&
    !result.testCoverage?.skippedFiles.length &&
    !incompleteTestOutput.test(result.output) &&
    !result.firstAttempt;
  return (
    ["pass", "fixed", "new_pass"].includes(check.verdict) &&
    !check.blocking &&
    clean(check.result) &&
    !check.firstAttempt
  );
}

/** Only structured sandbox blocks qualify; provenance and coverage come from factory records. */
export function applyGateEvidence(
  verify: Verify,
  spec: Spec,
  holdout: Holdout,
  sha: string,
  gates?: GateEvidence,
): Verify {
  return {
    ...verify,
    criteria: verify.criteria.map((blocked) => {
      if (blocked.status !== "blocked" || blocked.blockedReason !== "sandbox") return blocked;
      const refuse = (reason: string) => ({
        ...blocked,
        evidence: `Factory gate substitution unavailable: ${reason}.`,
      });
      if (!gates) return refuse("no completed candidate gate stage for this run");
      if (gates.sha !== sha || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha))
        return refuse("candidate gates did not check the exact verified SHA");
      if (!gates.checks.length || !gates.checks.every(passed))
        return refuse("candidate gate checks did not all pass cleanly without retries or skipped tests");
      const definitions = [
        ...spec.acceptance_criteria.filter((ac) => ac.id === blocked.id).map((ac) => ac.how_to_verify),
        ...holdout.scenarios
          .filter((scenario) => scenario.id === blocked.id)
          .map((scenario) => scenario.steps),
      ];
      if (definitions.length !== 1) return refuse("criterion has no unique verification definition");
      const commands = verificationCommands(definitions[0] ?? "");
      const covering = commands.map((command) => gates.checks.find((check) => covers(check, command)));
      if (!commands.length || covering.some((check) => !check))
        return refuse("candidate gate checks do not cover every required verification step");
      const checks = [...new Set(covering)].filter((check) => check !== undefined);
      const checkNames = checks.map((check) => check.name).join(", ");
      const checkCommands = checks.map((check) => check.result.command).join("; ");
      const citation = `Factory gate ${checkNames} passed at ${sha} (stage ${gates.stageId}); commands: ${checkCommands}`;
      return {
        ...blocked,
        status: "met" as const,
        evidence: citation,
        gateEvidence: {
          stageId: gates.stageId,
          sha,
          check: checkNames,
          command: checkCommands,
        },
      };
    }),
  };
}
