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

const coveringCitation = (run: CoveringTestRun, sha: string): string =>
  `Factory covering test ${run.file} › ${run.name} passed at ${sha} (stage ${run.stageId}); command: ${run.result?.executedCommand ?? run.result?.command}`;
const factoryClaim = /Factory (?:gate(?! substitution unavailable:)|covering test)\b/gi;

function citationRefusal(
  row: Verify["criteria"][number],
  sha: string,
  covering: { runs: CoveringTestRun[]; succeededStageIds: number[] } | undefined,
  eligibleGate: () => Verify["criteria"][number] | undefined,
): string | undefined {
  const validate = (citation: NonNullable<typeof row.gateEvidence>) => {
    if (citation.sha !== sha) return "citation is for a different verified SHA";
    const run = covering?.runs.find((r) => r.stageId === citation.stageId);
    if (run) {
      const reason = coveringTestRefusal(run, sha, covering?.succeededStageIds ?? []);
      if (reason) return reason;
      if (
        citation.check !== redactGateOutput(`${run.file} › ${run.name}`) ||
        citation.command !== redactGateOutput(run.result?.executedCommand ?? run.result?.command ?? "")
      )
        return "covering-test identity or command does not match the factory record";
      return undefined;
    }
    const gate = eligibleGate()?.gateEvidence;
    if (!gate) return "no eligible factory gate record for this criterion at the verified SHA";
    return citation.stageId === gate.stageId &&
      citation.check === gate.check &&
      citation.command === gate.command
      ? undefined
      : "gate stage, check or command does not match the factory record";
  };
  if (row.gateEvidence) {
    const reason = validate(row.gateEvidence);
    if (reason) return reason;
  }
  const gate = eligibleGate();
  const supported = [
    ...(gate?.gateEvidence ? [gate.evidence] : []),
    ...(covering?.runs ?? [])
      .filter((run) => !coveringTestRefusal(run, sha, covering?.succeededStageIds ?? []))
      .map((run) => redactGateOutput(coveringCitation(run, sha))),
  ];
  let remaining = row.evidence;
  for (let start = remaining.search(factoryClaim); start >= 0; start = remaining.search(factoryClaim)) {
    remaining = remaining.slice(start);
    // Consume complete factory-issued citations, including literal claim-like text inside test names.
    const citation = supported.find(
      (text) =>
        remaining.startsWith(text) &&
        (remaining.length === text.length ||
          remaining.slice(text.length).startsWith("; Factory ") ||
          /^(?:\.(?:$|\s)|[\r\n])/.test(remaining.slice(text.length))),
    );
    if (!citation) return "no factory record eligible for the cited stage, SHA, identity and command";
    remaining = remaining.slice(citation.length);
  }
  return undefined;
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
  const selected = selectCoveringTests(verify);
  return {
    ...verify,
    criteria: verify.criteria.map((blocked, index) => {
      if (blocked.gateEvidence || blocked.evidence.search(factoryClaim) >= 0) {
        const reason = citationRefusal(
          blocked,
          sha,
          coveringTests,
          () =>
            // Reuse the substitution eligibility checks without trusting any of the claimed evidence.
            applyGateEvidence(
              {
                ...verify,
                criteria: [
                  {
                    ...blocked,
                    status: "blocked",
                    blockedReason: "sandbox",
                    evidence: "",
                    gateEvidence: undefined,
                    covering_tests: undefined,
                  },
                ],
              },
              spec,
              holdout,
              sha,
              gates,
              baseline,
            ).criteria[0],
        );
        if (reason)
          return {
            ...blocked,
            status: "blocked" as const,
            gateEvidence: undefined,
            evidence: redactGateOutput(`Factory citation unavailable: ${reason}.`),
          };
      }
      if (blocked.status !== "blocked" || blocked.blockedReason !== "sandbox") return blocked;
      const refuse = (reason: string) => {
        const selection = selected[index];
        const runs =
          selection?.tests.map((test) =>
            coveringTests?.runs.find(
              (r) => r.verifiedSha === sha && r.file === test.file && r.name === test.name,
            ),
          ) ?? [];
        const failures = runs.map((run, i) => {
          const failure = coveringTestRefusal(run, sha, coveringTests?.succeededStageIds ?? []);
          return failure ? `covering test ${selection?.tests[i]?.file}: ${failure}` : undefined;
        });
        const failure = selection?.reason ?? failures.find(Boolean);
        if (!failure && runs.length) {
          const first = runs[0];
          if (first?.result)
            return {
              ...blocked,
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
        return {
          ...blocked,
          evidence: redactGateOutput(
            `Factory gate substitution unavailable: ${reason}${failure ? `; ${failure}` : ""}.`,
          ),
        };
      };
      if (!gates) return refuse("no completed candidate gate stage for this run");
      if (gates.sha !== sha || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha))
        return refuse("candidate gates did not check the exact verified SHA");
      if (!gates.checks.length)
        return refuse("candidate gate checks did not all pass cleanly without retries or skipped tests");
      const reason = gates.checks.map((check) => refusal(check, gates, baseline)).find(Boolean);
      if (reason) return refuse(reason);
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
        (count, check) => count + (check.result.testCoverage?.skippedTests?.length ?? 0),
        0,
      );
      const citation = `Factory gate ${checkNames} passed at ${sha} (stage ${gates.stageId}); commands: ${checkCommands}${inheritedSkips ? `; ${inheritedSkips} inherited skips` : ""}`;
      return {
        ...blocked,
        status: "met" as const,
        evidence: redactGateOutput(citation),
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
