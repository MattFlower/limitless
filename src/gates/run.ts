import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { runConfined, withCommandScratch } from "../harness/sandbox.ts";
import { agentEnv, invocationScratch } from "../util/proc.ts";
import { resolveTestWorkers } from "../util/test-workers.ts";
import type { GateCommand, GateConfig } from "./detect.ts";
import { executeGate, type GateRunner } from "./executor.ts";
import { FailureExcerpts } from "./failures.ts";
import { type FailedTestFiles, readJUnit, validRetryFiles } from "./junit.ts";
import {
  findGateCounterpart,
  launchFailure,
  launchFailureScan,
  redactGateOutput,
  redactGateStreams,
} from "./output.ts";
import { agentTestSlots, type GatePriority, gateSlots } from "./slots.ts";
import { BunTestCoverage, type TestCoverage } from "./test-coverage.ts";

export interface GateResult {
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
  targetedRetry?: GateResult;
}

export interface GateRun {
  setupOk: boolean;
  setup: GateResult[];
  checks: GateResult[];
}

export type GateVerdict =
  | "pass"
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
  /** The failing run that triggered a retry. */
  firstAttempt?: GateResult;
}

export interface GateHooks {
  priority?: GatePriority;
  holder?: string;
  /** Only bounded targeted retries may bypass the full-suite queue. */
  skipGateSlot?: boolean;
  onResult?: (r: GateResult, phase: "setup" | "check") => void;
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
async function runOne(cmd: GateCommand, cwd: string, signal: AbortSignal): Promise<GateResult> {
  const launch = launchFailureScan();
  const coverage = new BunTestCoverage(cwd);
  const excerpts = new FailureExcerpts();
  const observe = (line: string) => {
    line = redactGateOutput(line);
    coverage.observe(line);
    excerpts.observe(line);
  };
  const scratch = invocationScratch.getStore();
  if (!scratch) throw new Error("Missing gate command scratch");
  const report = join(scratch, `gate-report-${randomUUID()}.xml`);
  const res = await runConfined({
    command: cmd.run,
    cwd,
    env: { ...gateEnv(), LIMITLESS_GATE_REPORT: report },
    signal,
    timeoutMs: (cmd.timeoutSec ?? 900) * 1000,
    redactOutput: true,
    onRawChunk: launch.observe,
    onStdoutLine: observe,
    onStderrLine: observe,
  });
  const output = redactGateStreams(res.stdout, res.stderr);
  const combined = `${output.stdout}\n${output.stderr}`.trim();
  const testCoverage = coverage.result();
  const confinementError = launch.failed();
  const ok = !confinementError && res.exitCode === 0 && !res.timedOut && !res.cancelled;
  const failures = ok ? undefined : excerpts.result();
  return {
    name: cmd.name,
    command: cmd.run,
    ok,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    output: (res.timedOut ? "[timed out]\n" : "") + combined.slice(-OUTPUT_TAIL),
    ...readJUnit(report, cwd),
    ...(failures ? { failures } : {}),
    ...(res.timedOut ? { timedOut: true } : {}),
    // Both true and false record that the raw scan, rather than normalized output, is authoritative.
    confinementError,
    ...(testCoverage.summary || testCoverage.passedFiles.length || testCoverage.skippedFiles.length
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
  const release = await (hooks.skipGateSlot ? agentTestSlots : gateSlots).acquire(
    signal,
    hooks.skipGateSlot ? undefined : hooks.onWait,
    hooks.holder ?? basename(cwd),
    false,
    hooks.skipGateSlot ? undefined : hooks.priority,
  );
  try {
    return await withCommandScratch(cwd, () => runAll(cwd, cfg, signal, hooks.onResult));
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
    { repo: cwd, cwd, baseSha: "", headSha: "", gates: cfg, priority: hooks.priority },
    signal,
    hooks,
  );
}

async function runAll(
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  onResult: GateHooks["onResult"],
): Promise<GateRun> {
  const setup: GateResult[] = [];
  for (const [i, run] of cfg.setup.entries()) {
    const r = await runOne({ name: `setup${cfg.setup.length > 1 ? `-${i + 1}` : ""}`, run }, cwd, signal);
    setup.push(r);
    onResult?.(r, "setup");
    if (!r.ok) return { setupOk: false, setup, checks: [] };
  }
  const checks: GateResult[] = [];
  for (const c of cfg.checks) {
    if (signal.aborted) break;
    const r = await runOne(c, cwd, signal);
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
  const release = await (options.skipGateSlot ? agentTestSlots : gateSlots).acquire(
    signal,
    options.skipGateSlot ? undefined : onWait,
    basename(cwd),
  );
  try {
    const checks: GateResult[] = [];
    for (const check of cfg.checks) {
      if (signal.aborted) break;
      checks.push(await withCommandScratch(cwd, () => runOne(check, cwd, signal)));
    }
    return { setupOk: true, setup: [], checks };
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

/** First confirm known failing files; a pass alone still needs a full-suite retry. */
async function retryFailures(
  failures: { check: GateCommand; original: GateResult }[],
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  onWait?: GateHooks["onWait"],
  runner?: GateRunner,
): Promise<Map<GateResult, GateResult>> {
  const results = new Map<GateResult, GateResult>();
  const targets = new Map<GateResult, GateResult>();
  const full: typeof failures = [];
  for (const entry of failures) {
    if (signal.aborted) break;
    const { check, original } = entry;
    const files = original.failedFiles;
    if (cfg.retryFiles?.split("{files}").length === 2 && files && validRetryFiles(files, cwd)) {
      const times = files.map((file) => original.failedFileTimes?.[file]);
      const skipGateSlot =
        files.length <= UNSLOTTED_RETRY_MAX_FILES &&
        times.every((time) => time !== undefined && Number.isFinite(time) && time >= 0) &&
        times.reduce<number>((total, time) => total + (time ?? 0), 0) <= UNSLOTTED_RETRY_MAX_SECONDS;
      const quoted = files.map((file) => `'./${file.replaceAll("'", "'\\''")}'`).join(" ");
      const run = cfg.retryFiles.replace("{files}", () => quoted);
      const timeoutSec = skipGateSlot
        ? Math.min(check.timeoutSec ?? 900, 2 * UNSLOTTED_RETRY_MAX_SECONDS)
        : check.timeoutSec;
      const attempt = (
        await retryChecks(
          cwd,
          { ...cfg, setup: [], checks: [{ ...check, run, timeoutSec }] },
          signal,
          onWait,
          runner,
          { targeted: true, skipGateSlot },
        )
      ).checks[0];
      if (!attempt) continue;
      targets.set(original, attempt);
      if (confinementFailed(attempt) || (!attempt.ok && !attempt.timedOut)) {
        results.set(original, { ...original, firstAttempt: original, targetedRetry: attempt });
        continue;
      }
    }
    full.push(entry);
  }
  if (full.length && !signal.aborted) {
    const retried = await retryChecks(
      cwd,
      { ...cfg, setup: [], checks: full.map((entry) => entry.check) },
      signal,
      onWait,
      runner,
    );
    for (const [index, { original }] of full.entries()) {
      const result = retried.checks[index];
      if (result)
        results.set(original, { ...result, firstAttempt: original, targetedRetry: targets.get(original) });
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
): Promise<GateRun> {
  const selected = run.checks.flatMap((original) => {
    if (original.ok || original.timedOut || confinementFailed(original)) return [];
    const check = findGateCounterpart(original, run.checks, cfg.checks);
    return check?.run === original.command ? [{ check, original }] : [];
  });
  if (!run.setupOk || signal.aborted || !selected.length) return run;
  const results = await retryFailures(selected, cwd, cfg, signal, onWait, runner);
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
    const before = findGateCounterpart(r, after.checks, baseline?.checks ?? []);
    let verdict: GateVerdict;
    if (confinementFailed(r) || confinementFailed(before)) verdict = "confinement_error";
    else if (!before) verdict = r.ok ? "new_pass" : "new_failure";
    else if (before.ok && r.ok) verdict = "pass";
    else if (before.ok && !r.ok) verdict = "regressed";
    else if (!before.ok && r.ok) verdict = "fixed";
    else verdict = "still_failing";
    out.push({
      name: r.name,
      verdict,
      blocking:
        verdict === "confinement_error" ||
        !!r.timedOut ||
        verdict === "regressed" ||
        verdict === "new_failure",
      result: r,
    });
  }
  return out;
}

/** Whether the output names a location (`file:12`, `file(12,`) in one of the changed files. */
function pointsAt(output: string, changed: string[]): boolean {
  return changed.some((path) => {
    const name = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${name}(?::\\d|\\(\\d)`).test(output);
  });
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
): Promise<GateComparison[]> {
  // Matching the command too keeps a failed setup step (also "regressed") from being retried.
  const selected = cmp.flatMap((c) => {
    if (
      c.verdict !== "regressed" ||
      c.result.timedOut ||
      confinementFailed(c.result) ||
      pointsAt(c.result.output, changed)
    )
      return [];
    const check = findGateCounterpart(c, cmp, cfg.checks);
    return check?.run === c.result.command ? [{ check, original: c.result }] : [];
  });
  if (!selected.length || signal.aborted) return cmp;
  const results = await retryFailures(selected, cwd, cfg, signal, onWait, runner);
  return cmp.map((c) => {
    const retry = results.get(c.result);
    if (!retry) return c;
    const confinementError = confinementFailed(retry);
    return {
      ...c,
      verdict: confinementError ? "confinement_error" : retry.ok ? "flaky" : "regressed",
      blocking: confinementError || !retry.ok,
      result: retry,
      firstAttempt: c.result,
    };
  });
}
