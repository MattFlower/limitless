import { randomUUID } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { worktreeGit } from "../git/command.ts";
import { runConfined, withCommandScratch } from "../harness/sandbox.ts";
import { agentEnv, invocationScratch } from "../util/proc.ts";
import { resolveTestWorkers } from "../util/test-workers.ts";
import { RunnerFailureEvidence } from "./attribution.ts";
import type { GateCommand, GateConfig } from "./detect.ts";
import { type DocsSelection, quoteRetryFiles, singleBunTest } from "./docs.ts";
import { executeGate, type GateRunner, gateProvenance } from "./executor.ts";
import { FailureExcerpts } from "./failures.ts";
import {
  type CoveringTestEvidence,
  type FailedTestFiles,
  readCoveringJUnit,
  readJUnit,
  readJUnitSkips,
  validRetryFiles,
} from "./junit.ts";
import {
  findGateCounterpart,
  launchFailure,
  launchFailureScan,
  redactGateData,
  redactGateOutput,
  redactGateStreams,
} from "./output.ts";
import { acquireGateSlot, type GatePriority } from "./slots.ts";
import { BunTestCoverage, type TestCoverage } from "./test-coverage.ts";

export interface GateResult {
  /** Factory-authored execution identity; absent on legacy and local results. */
  executor?: { kind: "github-actions"; workflowSha: string; runsOn: string };
  /** Infrastructure stopped this command before a complete execution could be observed. */
  incomplete?: string;
  coveringTest?: CoveringTestEvidence;
  coveringTests?: CoveringTestEvidence[];
  /** Configured command plus factory-supplied arguments, when execution adds any. */
  executedCommand?: string;
  executionProvenance?: Pick<GateRun, "sha" | "trackedClean" | "provenanceError">;
  /** Successful execution rejected as evidence; the failed result remains authoritative. */
  retryAttempt?: GateResult;
  reused?: { executionId: string; treeHash: string; createdAt: number };
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string; // tail
  failures?: string;
  /** Set only when the process was killed for exceeding its timeout. */
  timedOut?: boolean;
  confinementError?: boolean;
  /** The first attempt of a check that was re-run; targeted evidence is kept separately. */
  firstAttempt?: GateResult;
  testCoverage?: TestCoverage;
  failedFiles?: string[];
  failedFileTimes?: FailedTestFiles["failedFileTimes"];
  /** Affirmative whole-stream and JUnit evidence, required only for targeted-only retries. */
  failureAttributionComplete?: boolean;
  /** Whole-stream/report diagnostic, independent of the retained output tail. */
  failureAttributionReason?: string;
  targetedRetry?: GateResult;
  docsOnly?: DocsSelection;
}

export interface GateRun {
  /** Post-execution checkout commit; absent in legacy records. */
  sha?: string;
  /** Post-execution committed tree from the checkout that executed the gates. */
  treeHash?: string;
  /** Affirmative post-execution inspection; absent in legacy remote results. */
  trackedClean?: boolean;
  provenanceError?: string;
  setupOk: boolean;
  setup: GateResult[];
  checks: GateResult[];
}

export type GateVerdict =
  | "pass"
  | "targeted_pass"
  | "targeted_failure"
  | "fixed"
  | "regressed"
  | "still_failing"
  | "new_failure"
  | "new_pass"
  | "not_run"
  | "flaky"
  | "confinement_error";

export interface GateComparison {
  name: string;
  verdict: GateVerdict;
  blocking: boolean;
  result: GateResult;
  /** The matched baseline check could not provide usable comparison evidence. */
  baselineConfinementError?: boolean;
  /** Post-merge execution: absent is local; null is LAN with unavailable attribution. */
  postMergeWorker?: string | null;
  /** Coordinator-owned confirmation; result retains the worker failure and prior retries. */
  coordinatorConfirmation?: {
    worker?: string;
    os?: string;
    originalVerdict: GateVerdict;
    reason: string;
    result?: GateResult;
  };
  retryProvenanceRejected?: boolean;
  retryOriginal?: { verdict: GateVerdict; blocking: boolean };
  /** The failing run that triggered a retry. */
  firstAttempt?: GateResult;
}

export interface GateHooks {
  env?: Record<string, string>;
  priority?: GatePriority;
  holder?: string;
  /** Only bounded targeted retries may bypass the full-suite queue. */
  skipGateSlot?: boolean;
  /** Recreate prerequisites if an in-place retry falls back after cleaning its worktree. */
  fallbackSetup?: string[];
  onResult?: (r: GateResult, phase: "setup" | "check") => void;
  /** Factory notification when the trusted shell starts a local check. */
  onCheckStart?: () => void;
  /** Factory confirmation that execution failed before a check could start. */
  onPreStartFailure?: () => void;
  /** Evidence from this process, never from a remote result or cache. */
  onLocalSetup?: () => void;
  /** Fires once when every gate slot is busy and this call has to queue. */
  onWait?: (slots: number) => void;
}

const OUTPUT_TAIL = 6_000;
export const confinementFailed = (r?: GateResult): boolean =>
  !!r &&
  ((r.confinementError ?? launchFailure(r.output)) ||
    confinementFailed(r.firstAttempt) ||
    confinementFailed(r.targetedRetry));

/** Gates execute code the agent wrote; give them the same scrubbed environment as agents. */
export const gateEnv = (): Record<string, string> =>
  agentEnv({
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    LIMITLESS_TEST_WORKERS: String(resolveTestWorkers()),
  });

/** Gates run confined to the checkout; a ConfinementError propagates so it can never grade a check. */
async function runOne(
  cmd: GateCommand,
  cwd: string,
  signal: AbortSignal,
  env = gateEnv(),
  onStarted?: () => void,
): Promise<GateResult> {
  const launch = launchFailureScan();
  const coverage = new BunTestCoverage(cwd);
  const excerpts = new FailureExcerpts();
  const evidence = new RunnerFailureEvidence();
  const observe = (line: string) => {
    evidence.observe(line);
    coverage.observe(line);
    line = redactGateOutput(line);
    excerpts.observe(line);
  };
  const scratch = invocationScratch.getStore();
  if (!scratch) throw new Error("Missing gate command scratch");
  const report = join(scratch, `gate-report-${randomUUID()}.xml`);
  const existed = existsSync(report);
  let reportBaseline = 0;
  const covering = cmd.coveringTests ?? (cmd.coveringTest ? [cmd.coveringTest] : []);
  if (covering.length) {
    const sentinel = `${report}.sentinel`;
    writeFileSync(sentinel, "", { flag: "wx" });
    reportBaseline = statSync(sentinel).mtimeMs;
  }
  const args = covering.length ? ["--reporter=junit", `--reporter-outfile=${report}`] : undefined;
  const res = await runConfined({
    command: cmd.run,
    args,
    cwd,
    env: { ...env, LIMITLESS_GATE_REPORT: report },
    signal,
    timeoutMs: (cmd.timeoutSec ?? 900) * 1000,
    redactOutput: true,
    onRawChunk: launch.observe,
    onStarted,
    onStdoutLine: observe,
    onStderrLine: observe,
  });
  const output = redactGateStreams(res.stdout, res.stderr);
  const combined = `${output.stdout}\n${output.stderr}`.trim();
  const skipReport = readJUnitSkips(report, cwd);
  const testCoverage = coverage.result(skipReport, evidence.agrees(skipReport?.counts));
  const confinementError = launch.failed();
  const ok = !confinementError && res.exitCode === 0 && !res.timedOut && !res.cancelled;
  const failures = ok ? undefined : excerpts.result();
  const { attributedCounts, failureAttributionReason, ...failedFiles } = readJUnit(report, cwd) ?? {};
  return {
    name: cmd.name,
    command: cmd.run,
    ...(args
      ? { executedCommand: `${cmd.run} ${args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}` }
      : {}),
    ...(cmd.coveringTest
      ? { coveringTest: readCoveringJUnit(report, cwd, cmd.coveringTest, reportBaseline, existed) }
      : {}),
    ...(cmd.coveringTests
      ? {
          coveringTests: covering.map((test) =>
            readCoveringJUnit(report, cwd, test, reportBaseline, existed),
          ),
        }
      : {}),
    ok,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    output: (res.timedOut ? "[timed out]\n" : "") + combined.slice(-OUTPUT_TAIL),
    ...failedFiles,
    failureAttributionComplete: evidence.agrees(attributedCounts),
    failureAttributionReason:
      redactGateOutput(
        [...new Set([failureAttributionReason, evidence.reason(attributedCounts)].filter(Boolean))].join(
          "; ",
        ),
      ) || undefined,
    ...(failures ? { failures } : {}),
    ...(res.timedOut ? { timedOut: true } : {}),
    // Both true and false record that the raw scan, rather than normalized output, is authoritative.
    confinementError,
    ...(testCoverage.summary ||
    testCoverage.passedFiles.length ||
    testCoverage.skippedFiles.length ||
    testCoverage.skippedTestsIncomplete
      ? { testCoverage }
      : {}),
  };
}

/** Run setup and checks inside one machine-wide gate slot. */
export async function runLocalGates(
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  hooks: GateHooks = {},
): Promise<GateRun> {
  const release = await acquireGateSlot(
    signal,
    hooks.onWait,
    hooks.holder ?? basename(cwd),
    hooks.skipGateSlot,
    hooks.priority,
  );
  try {
    const result = await withCommandScratch(cwd, () =>
      runAll(cwd, cfg, signal, hooks.onResult, hooks.env, hooks.onCheckStart),
    );
    if (result.setupOk && !signal.aborted) hooks.onLocalSetup?.();
    return result;
  } finally {
    release();
  }
}

/** Compatibility entry point for evals and standalone callers. */
export function runGates(
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  hooks: GateHooks = {},
): Promise<GateRun> {
  return executeGate(
    { repo: cwd, cwd, baseSha: "", headSha: "HEAD", gates: cfg, priority: hooks.priority },
    signal,
    hooks,
  );
}

async function runAll(
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  onResult: GateHooks["onResult"],
  env?: Record<string, string>,
  onCheckStart?: () => void,
): Promise<GateRun> {
  const setup: GateResult[] = [];
  for (const [i, run] of cfg.setup.entries()) {
    const r = await runOne(
      { name: `setup${cfg.setup.length > 1 ? `-${i + 1}` : ""}`, run },
      cwd,
      signal,
      env,
    );
    setup.push(r);
    onResult?.(r, "setup");
    if (!r.ok) return { setupOk: false, setup, checks: [] };
  }
  const checks: GateResult[] = [];
  for (const c of cfg.checks) {
    if (signal.aborted) break;
    const r = await runOne(c, cwd, signal, env, onCheckStart);
    checks.push(r);
    onResult?.(r, "check");
  }
  return { setupOk: true, setup, checks };
}

/** Standalone retries own scratch per check; an outer command scope still shares setup. */
async function retryChecks(
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  onWait: GateHooks["onWait"],
  runner?: GateRunner,
  options: GateRetryOptions = { targeted: false, skipGateSlot: false },
): Promise<GateRun> {
  if (runner) return runner(cfg, options);
  const release = await acquireGateSlot(signal, onWait, basename(cwd), options.skipGateSlot);
  try {
    const checks: GateResult[] = [];
    for (const check of cfg.checks) {
      if (signal.aborted) break;
      checks.push(await withCommandScratch(cwd, () => runOne(check, cwd, signal)));
    }
    return { setupOk: true, setup: [], checks, ...(await gateProvenance(cwd, signal)) };
  } finally {
    release();
  }
}

export interface GateRetryOptions {
  targeted: boolean;
  skipGateSlot: boolean;
}

export const UNSLOTTED_RETRY_MAX_FILES = 5;
export const UNSLOTTED_RETRY_MAX_SECONDS = 60;

/** Share the targeted-only decision with land diagnostics; legacy evidence stays ineligible. */
export function targetedRetrySkipReason(
  check: GateCommand | undefined,
  r: GateResult,
  cfg: GateConfig,
  cwd: string,
): string | undefined {
  if (confinementFailed(r)) return "confinement failure";
  if (r.timedOut) return "gate process timed out";
  if (r.exitCode == null) return "missing exit status";
  if (r.exitCode === 0) return "no nonzero exit status";
  if (r.failureAttributionComplete !== true)
    return `failure attribution incomplete: ${r.failureAttributionReason ?? "missing or inconsistent whole-stream/JUnit evidence"}`;
  const placeholderReason = "retry_files must contain {files} once as an unquoted standalone argument";
  if (cfg.retryFiles?.split("{files}").length !== 2) return placeholderReason;
  if (!r.failedFiles?.length) return "absent retry files";
  if (!validRetryFiles(r.failedFiles, cwd)) return "invalid retry files";
  if (!check || !singleBunTest(check.run) || !singleBunTest(r.command))
    return "check is not a single bun test invocation";
  if (!singleBunTest(cfg.retryFiles)) return "retry_files is not a single bun test invocation";
  if (!singleBunTest(cfg.retryFiles, "{files}")) return placeholderReason;
  const quoted = quoteRetryFiles(r.failedFiles);
  if (!singleBunTest(cfg.retryFiles.replace("{files}", () => quoted)))
    return "expanded retry_files is not a single bun test invocation";
  return undefined;
}

function retrySetupFailure(original: GateResult, run: GateRun): GateResult {
  const failed = run.setup.find((r) => !r.ok);
  return {
    ...original,
    firstAttempt: original,
    output: `${original.output}\n\nRetry setup failed:\n$ ${failed?.command ?? "setup"}\n${failed?.failures ?? ""}\n${failed?.output ?? "No setup result"}`,
    confinementError: confinementFailed(original) || confinementFailed(failed),
  };
}

/** A retry can clear a failure only on the checked, unchanged tracked tree. */
export function validateRetry(
  attempt: GateResult,
  original: GateResult,
  sha: string | undefined,
  provenance = attempt.executionProvenance,
  onReject?: (original: GateResult, reason: string) => void,
): GateResult {
  const { sha: executedSha, trackedClean, provenanceError } = provenance ?? {};
  const result = {
    ...attempt,
    executionProvenance: redactGateData({ sha: executedSha, trackedClean, provenanceError }),
  };
  if (!attempt.ok || confinementFailed(attempt)) return result;
  const reason =
    !sha || !executedSha
      ? "missing execution SHA provenance"
      : executedSha !== sha
        ? `execution SHA ${executedSha} does not match checked commit ${sha}`
        : trackedClean !== true
          ? "tracked checkout cleanliness was not confirmed"
          : undefined;
  if (!reason) return result;
  const diagnostic = redactGateOutput(
    `Retry rejected: ${reason}${provenanceError ? `; ${provenanceError}` : ""}`,
  );
  onReject?.(original, diagnostic);
  return {
    ...original,
    firstAttempt: original,
    retryAttempt: result,
    confinementError: confinementFailed(original),
    output: `${original.output}\n\n${diagnostic}`,
    ...(original.failures ? { failures: `${original.failures}\n\n${diagnostic}` } : {}),
  };
}

/** Confirm known failing files; factory gates also require a full-suite retry after a pass. */
export async function retryFailures(
  failures: { check: GateCommand; original: GateResult }[],
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  onWait?: GateHooks["onWait"],
  runner?: GateRunner,
  targetedOnly = false,
  freshCheckout = false,
  onSkip?: (original: GateResult, reason: string) => void,
): Promise<Map<GateResult, GateResult>> {
  const results = new Map<GateResult, GateResult>();
  const sha = await worktreeGit(["git", "rev-parse", "HEAD"], { cwd, signal })
    .then((r) => r.stdout.trim())
    .catch(() => undefined);
  const targets = new Map<GateResult, GateResult>();
  const full: typeof failures = [];
  for (const entry of failures) {
    if (signal.aborted) break;
    const { check, original } = entry;
    const skip = targetedOnly ? targetedRetrySkipReason(check, original, cfg, cwd) : undefined;
    if (targetedOnly && (original.ok || skip)) {
      if (skip) onSkip?.(original, skip);
      continue;
    }
    const files = original.failedFiles;
    if (cfg.retryFiles?.split("{files}").length === 2 && files && validRetryFiles(files, cwd)) {
      const times = files.map((file) => original.failedFileTimes?.[file]);
      const skipGateSlot =
        files.length <= UNSLOTTED_RETRY_MAX_FILES &&
        times.every((time) => time !== undefined && Number.isFinite(time) && time >= 0) &&
        times.reduce<number>((total, time) => total + (time ?? 0), 0) <= UNSLOTTED_RETRY_MAX_SECONDS;
      const quoted = quoteRetryFiles(files);
      const run = cfg.retryFiles.replace("{files}", () => quoted);
      const timeoutSec = skipGateSlot
        ? Math.min(check.timeoutSec ?? 900, 2 * UNSLOTTED_RETRY_MAX_SECONDS)
        : check.timeoutSec;
      const retried = await retryChecks(
        cwd,
        { ...cfg, setup: freshCheckout ? cfg.setup : [], checks: [{ ...check, run, timeoutSec }] },
        signal,
        onWait,
        runner,
        { targeted: true, skipGateSlot },
      );
      if (!retried.setupOk) {
        onSkip?.(original, "retry setup failed");
        results.set(original, retrySetupFailure(original, retried));
        continue;
      }
      const raw = retried.checks[0];
      if (!raw) continue;
      const attempt = validateRetry(raw, original, sha, retried, onSkip);
      const target = attempt.retryAttempt ?? attempt;
      targets.set(original, target);
      if (targetedOnly) {
        results.set(original, { ...attempt, firstAttempt: original, targetedRetry: target });
        continue;
      }
      if ((raw.ok && !attempt.ok) || confinementFailed(attempt) || (!attempt.ok && !attempt.timedOut)) {
        results.set(original, {
          ...(raw.ok && !attempt.ok ? attempt : original),
          firstAttempt: original,
          targetedRetry: target,
        });
        continue;
      }
    }
    if (!targetedOnly) full.push(entry);
  }
  if (full.length && !signal.aborted) {
    const retried = await retryChecks(
      cwd,
      { ...cfg, setup: freshCheckout ? cfg.setup : [], checks: full.map((entry) => entry.check) },
      signal,
      onWait,
      runner,
    );
    for (const [index, { original }] of full.entries()) {
      if (!retried.setupOk) {
        results.set(original, {
          ...retrySetupFailure(original, retried),
          targetedRetry: targets.get(original),
        });
        continue;
      }
      const result = retried.checks[index];
      if (result)
        results.set(original, {
          ...validateRetry(result, original, sha, retried, onSkip),
          firstAttempt: original,
          targetedRetry: targets.get(original),
        });
    }
  }
  return results;
}

/** Retry baseline failures before comparison, retaining the original failure and every attempt. */
export async function retryBaselineFailures(
  run: GateRun,
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  onWait?: GateHooks["onWait"],
  runner?: GateRunner,
  freshCheckout = false,
): Promise<GateRun> {
  const selected = run.checks.flatMap((original) => {
    if (original.ok || original.timedOut || confinementFailed(original)) return [];
    const check = findGateCounterpart(original, run.checks, cfg.checks);
    return check?.run === original.command ? [{ check, original }] : [];
  });
  if (!run.setupOk || signal.aborted || !selected.length) return run;
  const results = await retryFailures(selected, cwd, cfg, signal, onWait, runner, false, freshCheckout);
  return { ...run, checks: run.checks.map((r) => results.get(r) ?? r) };
}

/** Compare post-change gates with the baseline taken on the untouched base branch. */
export function compareGates(baseline: GateRun | null, after: GateRun): GateComparison[] {
  const out: GateComparison[] = [];
  if (!after.setupOk) {
    // Nothing downstream ran, so nothing was verified: always blocking, even if setup was
    // already broken on the base branch.
    const failed = after.setup.find((s) => !s.ok);
    const verdict = confinementFailed(failed) ? "confinement_error" : "regressed";
    if (failed) out.push({ name: failed.name, verdict, blocking: true, result: failed });
    const skipped = baseline?.checks ?? [];
    for (const c of skipped) {
      out.push({
        name: c.name,
        verdict: "not_run",
        blocking: true,
        result: {
          name: c.name,
          command: c.command,
          ok: false,
          exitCode: null,
          durationMs: 0,
          output: "not run: setup failed",
        },
      });
    }
    return out;
  }
  for (const r of after.checks) {
    if (r.incomplete) {
      out.push({ name: r.name, verdict: "not_run", blocking: true, result: r });
      continue;
    }
    if (r.docsOnly?.mode === "skipped") {
      out.push({ name: r.name, verdict: "not_run", blocking: false, result: r });
      continue;
    }
    const before = findGateCounterpart(r, after.checks, baseline?.checks ?? []);
    const baselineConfinementError = confinementFailed(before);
    let verdict: GateVerdict;
    if (confinementFailed(r)) verdict = "confinement_error";
    else if (r.docsOnly?.mode === "targeted") verdict = r.ok ? "targeted_pass" : "targeted_failure";
    // A skipped reference provides no evidence that a later failure already existed.
    else if (!before || before.docsOnly?.mode === "skipped" || baselineConfinementError)
      verdict = r.ok ? "new_pass" : "new_failure";
    else if (before.ok && r.ok) verdict = "pass";
    else if (before.ok && !r.ok) verdict = "regressed";
    else if (!before.ok && r.ok) verdict = "fixed";
    else verdict = actionsEvidence(r) || actionsEvidence(before) ? "new_failure" : "still_failing";
    out.push({
      name: r.name,
      verdict,
      blocking:
        verdict === "confinement_error" ||
        !!r.timedOut ||
        verdict === "targeted_failure" ||
        verdict === "regressed" ||
        verdict === "new_failure",
      result: r,
      ...(baselineConfinementError ? { baselineConfinementError: true } : {}),
    });
  }
  return out;
}

/** Actions execution identity is not established as equivalent to any baseline's. */
const actionsEvidence = (r?: GateResult): boolean =>
  !!r && (!!r.executor || [r.firstAttempt, r.retryAttempt, r.targetedRetry].some(actionsEvidence));

/** Whether the output names a location (`file:12`, `file(12,`) in one of the changed files. */
function pointsAt(output: string, changed: string[]): boolean {
  return changed.some((path) => {
    const name = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${name}(?::\\d|\\(\\d)`).test(output);
  });
}

const SLOW_REGRESSION_FACTOR = 3;
const SLOW_REGRESSION_INCREASE_MS = 60_000;

/** Only an unretried regression far slower than its own passing reference earns a re-check. */
export function isSlowRegression(
  c: GateComparison,
  comparisons: GateComparison[],
  reference: GateResult[],
): boolean {
  const r = c.result;
  const before = findGateCounterpart(c, comparisons, reference);
  return (
    (c.verdict === "regressed" || c.verdict === "targeted_failure") &&
    !r.timedOut &&
    !confinementFailed(r) &&
    !r.firstAttempt &&
    !!before?.ok &&
    before.durationMs > 0 &&
    r.durationMs > SLOW_REGRESSION_FACTOR * before.durationMs &&
    r.durationMs - before.durationMs >= SLOW_REGRESSION_INCREASE_MS
  );
}

/**
 * Re-run once, inside a slot, each check that passed on the baseline but failed after the change
 * without its output pointing at a changed file. A pass on retry is `flaky` and doesn't block.
 */
export async function retryRegressions(
  cmp: GateComparison[],
  cwd: string,
  cfg: GateConfig,
  changed: string[],
  signal: AbortSignal,
  onWait?: GateHooks["onWait"],
  runner?: GateRunner,
  freshCheckout = false,
  select: (c: GateComparison) => boolean = (c) => !pointsAt(c.result.output, changed),
): Promise<GateComparison[]> {
  // Matching the command too keeps a failed setup step (also "regressed") from being retried.
  const selected = cmp.flatMap((c) => {
    if (
      c.result.reused ||
      (c.verdict !== "regressed" && c.verdict !== "targeted_failure") ||
      c.result.timedOut ||
      confinementFailed(c.result) ||
      !select(c)
    )
      return [];
    const check = findGateCounterpart(c, cmp, cfg.checks);
    return check?.run === c.result.command ? [{ check, original: c.result }] : [];
  });
  if (!selected.length || signal.aborted) return cmp;
  const results = await retryFailures(selected, cwd, cfg, signal, onWait, runner, false, freshCheckout);
  return cmp.map((c) => {
    const retry = results.get(c.result);
    if (!retry) return c;
    const confinementError = confinementFailed(retry);
    return {
      ...c,
      retryOriginal: c.retryOriginal ?? { verdict: c.verdict, blocking: c.blocking },
      verdict: confinementError ? "confinement_error" : retry.ok ? "flaky" : c.verdict,
      blocking: confinementError || !retry.ok,
      result: { ...retry, ...(c.result.docsOnly ? { docsOnly: c.result.docsOnly } : {}) },
      firstAttempt: c.result,
    };
  });
}
