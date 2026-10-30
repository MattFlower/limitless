import { redactGateOutput } from "../gates/output.ts";
import { confinementFailed, type GateComparison, type GateRun } from "../gates/run.ts";
import { BunTestCoverage, MAX_SKIPPED_TESTS, MAX_TEST_IDENTITY_LENGTH } from "../gates/test-coverage.ts";
import { type CoveringTestRun, coveringTestRefusal, selectCoveringTests } from "./covering-tests.ts";
import type { Holdout, Spec, Verify } from "./schemas.ts";

/** Factory provenance, saved with the completed candidate gate stage (never baseline checks). */
export interface GateEvidence {
  stageId: number;
  sha: string;
  baseSha?: string;
  changedFiles?: string[];
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
  // Targeted coverage needs passing rows in each requested file, even with inherited skips.
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
  const ran = coverage.passedFiles;
  if (!requested.length) return command === "bun test" && ran.length > 0;
  return requested.every((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && ran.includes(file));
}

const clean = (result: GateComparison["result"]): boolean =>
  result.ok &&
  result.exitCode === 0 &&
  !result.timedOut &&
  !confinementFailed(result) &&
  !result.testCoverage?.summary?.failed &&
  !incompleteTestOutput.test(result.output) &&
  !result.firstAttempt;

function completeSkips(result: GateComparison["result"]): boolean {
  const coverage = result.testCoverage;
  const skips = coverage?.skippedTests;
  return (
    !!coverage?.summary &&
    coverage.summary.passed > 0 &&
    !coverage.skippedTestsIncomplete &&
    !!skips?.length &&
    skips.length <= MAX_SKIPPED_TESTS &&
    skips.every(
      ({ file, name, line }) =>
        line !== undefined &&
        Number.isSafeInteger(line) &&
        line > 0 &&
        file.length > 0 &&
        name.trim().length > 0 &&
        Math.max(file.length, name.length) <= MAX_TEST_IDENTITY_LENGTH &&
        !file.startsWith("/") &&
        !file.includes("\\") &&
        !file.split("/").some((p) => !p || p === "." || p === "..") &&
        ![...(file + name)].some(
          (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
        ) &&
        redactGateOutput(file) === file &&
        redactGateOutput(name) === name,
    ) &&
    coverage.skippedFiles.every((file) => skips.some((skip) => skip.file === file))
  );
}

function refusal(
  check: GateEvidence["checks"][number],
  gates: GateEvidence,
  baseline?: GateRun | null,
): string | undefined {
  if (check.result.docsOnly)
    return `docs-only ${check.result.docsOnly.mode === "skipped" ? "skip" : "targeting"}: ${check.result.docsOnly.reason}`;
  if (check.verdict === "targeted_pass" || check.verdict === "targeted_failure")
    return "targeted test check; full suite did not run";
  if (
    !["pass", "fixed", "new_pass"].includes(check.verdict) ||
    check.blocking ||
    !clean(check.result) ||
    check.firstAttempt
  )
    return "candidate gate checks did not all pass cleanly without retries or skipped tests";
  const coverage = check.result.testCoverage;
  if (coverage?.skippedTestsIncomplete) return "candidate skip evidence is incomplete";
  if (
    !coverage?.skippedTests?.length &&
    !coverage?.skippedFiles.length &&
    !skippedTestOutput.test(check.result.output)
  )
    return undefined;
  if (!completeSkips(check.result)) return "candidate skip identities unavailable or incomplete";
  if (!baseline?.sha || !gates.baseSha || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(gates.baseSha))
    return "baseline commit provenance unavailable";
  if (baseline.sha !== gates.baseSha) return "baseline commit does not match the checked base";
  const base = baseline.checks.find((r) => r.name === check.name);
  if (!base) return "baseline skip identities unavailable for this check";
  if (base.command !== check.result.command) return "baseline check command does not match";
  if (!baseline.setupOk || !clean(base)) return "baseline check failed or was retried";
  if (!completeSkips(base)) return "baseline skip identities unavailable or incomplete";
  if (!gates.changedFiles) return "candidate changed-file provenance unavailable";
  const skips = coverage?.skippedTests ?? [];
  if (skips.some((skip) => gates.changedFiles?.includes(skip.file)))
    return "skipped-test files changed in the candidate diff";
  const remaining = new Map<string, number>();
  for (const skip of base.testCoverage?.skippedTests ?? []) {
    const key = JSON.stringify([skip.file, skip.name, skip.line]);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const skip of skips) {
    const key = JSON.stringify([skip.file, skip.name, skip.line]);
    const count = remaining.get(key) ?? 0;
    if (!count) return "skipped-test occurrences not inherited from the baseline";
    remaining.set(key, count - 1);
  }
  return undefined;
}

export const coveringCitation = (run: CoveringTestRun, sha: string): string =>
  `Factory covering test ${run.file} › ${run.name} passed at ${sha} (stage ${run.stageId}); command: ${run.result?.executedCommand ?? run.result?.command}`;
type Binding = {
  evidence: string;
  gateEvidence: NonNullable<Verify["criteria"][number]["gateEvidence"]>;
};

function gateBinding(
  id: string,
  spec: Spec,
  holdout: Holdout,
  sha: string,
  gates?: GateEvidence,
  baseline?: GateRun | null,
): Binding | { reason: string } {
  if (!gates) return { reason: "no completed candidate gate stage for this run" };
  if (gates.sha !== sha || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha))
    return { reason: "candidate gates did not check the exact verified SHA" };
  if (!gates.checks.length)
    return { reason: "candidate gate checks did not all pass cleanly without retries or skipped tests" };
  const reason = gates.checks.map((check) => refusal(check, gates, baseline)).find(Boolean);
  if (reason) return { reason };
  const definitions = [
    ...spec.acceptance_criteria
      .filter((ac) => ac.id === id)
      .map((ac) => ({ steps: ac.how_to_verify, expected: ac.criterion })),
    ...holdout.scenarios
      .filter((scenario) => scenario.id === id)
      .map((scenario) => ({ steps: scenario.steps, expected: scenario.expected })),
  ];
  if (definitions.length !== 1) return { reason: "criterion has no unique verification definition" };
  const definition = definitions[0];
  // Exit success attests only to tests passing, never to an additional observable outcome.
  if (
    !definition ||
    !/^(?:(?:the|all|both|targeted|covered|project|gate)\s+)*(?:[\w./-]+\s+)?tests?(?:\s+suite)?\s+pass(?:es)?[.!]?$/i.test(
      definition.expected.trim(),
    )
  )
    return { reason: "required outcome is not solely that tests pass" };
  const commands = verificationCommands(definition.steps);
  const covering = commands.map((command) => gates.checks.find((check) => covers(check, command)));
  if (!commands.length || covering.some((check) => !check))
    return { reason: "candidate gate checks do not cover every required verification step" };
  const checks = [...new Set(covering)].filter((check) => check !== undefined);
  const checkNames = checks.map((check) => check.name).join(", ");
  const checkCommands = checks.map((check) => check.result.command).join("; ");
  const inheritedSkips = checks.reduce(
    (count, check) => count + (check.result.testCoverage?.skippedTests?.length ?? 0),
    0,
  );
  const citation = `Factory gate ${checkNames} passed at ${sha} (stage ${gates.stageId}); commands: ${checkCommands}${inheritedSkips ? `; ${inheritedSkips} inherited skips` : ""}`;
  return {
    evidence: redactGateOutput(citation),
    gateEvidence: {
      stageId: gates.stageId,
      sha,
      check: checkNames,
      command: checkCommands,
    },
  };
}

function citationRefusal(
  citation: Binding["gateEvidence"],
  sha: string,
  covering: { runs: CoveringTestRun[]; succeededStageIds: number[] } | undefined,
  gate: Binding | { reason: string },
): string | undefined {
  if (citation.sha !== sha) return "citation is for a different verified SHA";
  const run = covering?.runs.find((r) => r.stageId === citation.stageId);
  if (run) {
    const reason = coveringTestRefusal(run, sha, covering?.succeededStageIds ?? []);
    if (reason) return reason;
    return citation.check === redactGateOutput(`${run.file} › ${run.name}`) &&
      citation.command === redactGateOutput(run.result?.executedCommand ?? run.result?.command ?? "")
      ? undefined
      : "covering-test identity or command does not match the factory record";
  }
  if ("reason" in gate) return `no eligible factory gate record: ${gate.reason}`;
  return citation.stageId === gate.gateEvidence.stageId &&
    citation.check === gate.gateEvidence.check &&
    citation.command === gate.gateEvidence.command
    ? undefined
    : "gate stage, check or command does not match the factory record";
}

/** Only structured sandbox blocks qualify; provenance and coverage come from factory records. */
export function applyGateEvidence(
  verify: Verify,
  spec: Spec,
  holdout: Holdout,
  sha: string,
  gates?: GateEvidence,
  baseline?: GateRun | null,
  coveringTests?: { runs: CoveringTestRun[]; succeededStageIds: number[] },
): Verify {
  // A claimed met row with test requests still needs every requested factory execution.
  const selected = selectCoveringTests({
    ...verify,
    criteria: verify.criteria.map((row) =>
      row.status === "met" && row.covering_tests?.length
        ? { ...row, status: "blocked", blockedReason: "sandbox" }
        : row,
    ),
  });
  return {
    ...verify,
    criteria: verify.criteria.map((row, index) => {
      const sandbox = row.status === "blocked" && row.blockedReason === "sandbox";
      const requested = !!row.covering_tests?.length;
      if (!row.gateEvidence && !sandbox && !(row.status === "met" && requested)) return row;
      const gate = gateBinding(row.id, spec, holdout, sha, gates, baseline);
      const selection = selected[index];
      const runs =
        selection?.tests.map((test) =>
          coveringTests?.runs.find(
            (r) => r.verifiedSha === sha && r.file === test.file && r.name === test.name,
          ),
        ) ?? [];
      const failures = runs.map((run, i) => {
        const reason = coveringTestRefusal(run, sha, coveringTests?.succeededStageIds ?? []);
        return reason ? `covering test ${selection?.tests[i]?.file}: ${reason}` : undefined;
      });
      const coveringFailure =
        selection?.reason ??
        failures.find(Boolean) ??
        (requested && !runs.length ? "no factory record" : undefined);
      const refuse = (prefix: string, reason: string) => ({
        ...row,
        status: "blocked" as const,
        gateEvidence: undefined,
        evidence: redactGateOutput(`${prefix}: ${reason}.`),
      });
      if (row.gateEvidence) {
        const reason = citationRefusal(row.gateEvidence, sha, coveringTests, gate) ?? coveringFailure;
        if (reason) return refuse("Factory citation unavailable", reason);
        if (!sandbox && !requested) return row;
      }
      if (requested) {
        if (coveringFailure)
          return refuse(
            "Factory gate substitution unavailable",
            `${"reason" in gate ? `${gate.reason}; ` : ""}${coveringFailure}`,
          );
        const first = runs[0];
        if (first?.result)
          return {
            ...row,
            status: "met" as const,
            evidence: redactGateOutput(runs.map((r) => (r ? coveringCitation(r, sha) : "")).join("; ")),
            gateEvidence: {
              stageId: first.stageId,
              sha,
              check: redactGateOutput(`${first.file} › ${first.name}`),
              command: redactGateOutput(first.result.executedCommand ?? first.result.command),
            },
          };
      }
      if ("reason" in gate) return refuse("Factory gate substitution unavailable", gate.reason);
      return { ...row, status: "met" as const, ...gate };
    }),
  };
}
