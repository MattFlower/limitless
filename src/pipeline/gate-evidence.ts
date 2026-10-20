import { confinementFailed, type GateComparison, type GateRun } from "../gates/run.ts";
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
  return expanded && /^bun test(?: [\w./-]+)*$/.test(expanded) ? expanded : null;
}

// Runner status rows and summaries, not words inside passing test names or diagnostic prose.
const incompleteTestOutput =
  /^\s*(?:\(fail\)(?:\s|$)|(?:[1-9]\d* (?:fail(?:ed)?|not run)|0 pass)\s*$|not run:\s)/im;
const skippedTestOutput = /^\s*(?:\((?:skip|todo)\)(?:\s|$)|[1-9]\d* (?:skip(?:ped)?|todo)\s*$)/im;

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
  if (!command || !/^bun test(?: [\w./-]+)*$/.test(command)) return false;
  // File headers and passing rows prove that the broad suite actually discovered and ran the file.
  // Inherited skip identities also prove discovery; flags/filters and unsupported runners refuse.
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
  const recorded = new BunTestCoverage();
  for (const line of check.result.output.split(/\r?\n/)) recorded.observe(line);
  const coverage = check.result.testCoverage ?? recorded.result();
  if (!coverage.summary || coverage.summary.passed < 1 || coverage.summary.failed !== 0) return false;
  const ran = [...coverage.passedFiles, ...(coverage.skippedTests ?? []).map((test) => test.file)];
  if (!requested.length) return command === "bun test" && ran.length > 0;
  return requested.every((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && ran.includes(file));
}

function passed(check: GateEvidence["checks"][number], baseline?: GateRun | null): boolean {
  const base = baseline?.checks.find((r) => r.name === check.name && r.command === check.result.command);
  const skips = check.result.testCoverage?.skippedTests;
  const baseSkips = base?.testCoverage?.skippedTests;
  const complete = (result: GateComparison["result"]) =>
    !!result.testCoverage?.summary &&
    result.testCoverage.summary.passed > 0 &&
    result.testCoverage.skippedFiles.every((file) =>
      result.testCoverage?.skippedTests?.some((skip) => skip.file === file),
    );
  const inherited =
    !!skips?.length &&
    !!baseSkips?.length &&
    !!base &&
    !!complete(check.result) &&
    !!complete(base) &&
    skips.every((skip) => baseSkips.some((old) => old.file === skip.file && old.name === skip.name));
  const clean = (result: GateComparison["result"], allowSkips: boolean): boolean =>
    result.ok &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !confinementFailed(result) &&
    !result.testCoverage?.summary?.failed &&
    !result.testCoverage?.skippedTestsIncomplete &&
    (allowSkips || (!result.testCoverage?.skippedFiles.length && !skippedTestOutput.test(result.output))) &&
    !incompleteTestOutput.test(result.output) &&
    !result.firstAttempt;
  return (
    ["pass", "fixed", "new_pass"].includes(check.verdict) &&
    !check.blocking &&
    clean(check.result, inherited && clean(base, true)) &&
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
  baseline?: GateRun | null,
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
      if (!gates.checks.length || !gates.checks.every((check) => passed(check, baseline)))
        return refuse("candidate gate checks did not all pass cleanly without retries or skipped tests");
      const definitions = [
        ...spec.acceptance_criteria
          .filter((ac) => ac.id === blocked.id)
          .map((ac) => ({ steps: ac.how_to_verify, expected: ac.criterion })),
        ...holdout.scenarios
          .filter((scenario) => scenario.id === blocked.id)
          .map((scenario) => ({ steps: scenario.steps, expected: scenario.expected })),
      ];
      if (definitions.length !== 1) return refuse("criterion has no unique verification definition");
      const definition = definitions[0];
      // Exit success attests only to tests passing, never to an additional observable outcome.
      if (
        !definition ||
        !/^(?:(?:the|all|both|targeted|covered|project|gate)\s+)*(?:[\w./-]+\s+)?tests?(?:\s+suite)?\s+pass(?:es)?[.!]?$/i.test(
          definition.expected.trim(),
        )
      )
        return refuse("required outcome is not solely that tests pass");
      const commands = verificationCommands(definition.steps);
      const covering = commands.map((command) => gates.checks.find((check) => covers(check, command)));
      if (!commands.length || covering.some((check) => !check))
        return refuse("candidate gate checks do not cover every required verification step");
      const checks = [...new Set(covering)].filter((check) => check !== undefined);
      const checkNames = checks.map((check) => check.name).join(", ");
      const checkCommands = checks.map((check) => check.result.command).join("; ");
      const inheritedSkips = checks.reduce(
        (count, check) =>
          count +
          new Set(
            check.result.testCoverage?.skippedTests?.map((skip) => JSON.stringify([skip.file, skip.name])),
          ).size,
        0,
      );
      const citation = `Factory gate ${checkNames} passed at ${sha} (stage ${gates.stageId}); commands: ${checkCommands}${inheritedSkips ? `; ${inheritedSkips} inherited skips` : ""}`;
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
