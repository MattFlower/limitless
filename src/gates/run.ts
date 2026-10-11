import { basename } from "node:path";
import { runConfined, withCommandScratch } from "../harness/sandbox.ts";
import { agentEnv } from "../util/proc.ts";
import { resolveTestWorkers } from "../util/test-workers.ts";
import type { GateCommand, GateConfig } from "./detect.ts";
import { executeGate, type GateRunner } from "./executor.ts";
import { FailureExcerpts } from "./failures.ts";
import { launchFailure, launchFailureScan, redactGateOutput, redactGateStreams } from "./output.ts";
import { gateSlots } from "./slots.ts";
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
  /** The first attempt of a check that was re-run; this result is the re-run. */
  firstAttempt?: GateResult;
  testCoverage?: TestCoverage;
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
  /** The failing run that triggered a retry; `result` is then the retry. */
  firstAttempt?: GateResult;
}

export interface GateHooks {
  holder?: string;
  onResult?: (r: GateResult, phase: "setup" | "check") => void;
  /** Fires once when every gate slot is busy and this call has to queue. */
  onWait?: (slots: number) => void;
}

const OUTPUT_TAIL = 6_000;
export const confinementFailed = (r?: GateResult): boolean =>
  !!r && ((r.confinementError ?? launchFailure(r.output)) || confinementFailed(r.firstAttempt));

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
  const res = await runConfined({
    command: cmd.run,
    cwd,
    env: gateEnv(),
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
  const release = await gateSlots.acquire(signal, hooks.onWait, hooks.holder ?? basename(cwd));
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
  return executeGate({ repo: cwd, cwd, baseSha: "", headSha: "", gates: cfg }, signal, hooks);
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

/**
 * Re-run once, inside a slot, each baseline check that failed without timing out. A check that
 * fails on base never blocks later, so a flaky baseline failure would hide a real regression.
 * The re-run becomes the result, with the failure kept as `firstAttempt`; only a pass changes the outcome.
 */
export async function retryBaselineFailures(
  run: GateRun,
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  onWait?: GateHooks["onWait"],
  runner: GateRunner = (gates) => runGates(cwd, gates, signal, { onWait }),
): Promise<GateRun> {
  const retryable = (r: GateResult) =>
    !r.ok && !r.timedOut && !confinementFailed(r)
      ? cfg.checks.find((k) => k.name === r.name && k.run === r.command)
      : undefined;
  if (!run.setupOk || signal.aborted || !run.checks.some(retryable)) return run;
  const selected = run.checks.flatMap((r) => {
    const check = retryable(r);
    return check ? [check] : [];
  });
  const retry = await runner({ ...cfg, setup: [], checks: selected });
  let index = 0;
  return {
    ...run,
    checks: run.checks.map((r) => {
      const result = retryable(r) ? retry.checks[index++] : undefined;
      return result ? { ...result, firstAttempt: r } : r;
    }),
  };
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
    const before = baseline?.checks.find((b) => b.name === r.name);
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
  runner: GateRunner = (gates) => runGates(cwd, gates, signal, { onWait }),
): Promise<GateComparison[]> {
  // Matching the command too keeps a failed setup step (also "regressed") from being retried.
  const retryable = (c: GateComparison) =>
    c.verdict === "regressed" && !c.result.timedOut && !pointsAt(c.result.output, changed)
      ? cfg.checks.find((k) => k.name === c.name && k.run === c.result.command)
      : undefined;
  if (!cmp.some(retryable)) return cmp;
  const selected = cmp.flatMap((c) => {
    const check = retryable(c);
    return check ? [check] : [];
  });
  const retried = await runner({ ...cfg, setup: [], checks: selected });
  let index = 0;
  return cmp.map((c) => {
    const retry = retryable(c) ? retried.checks[index++] : undefined;
    return retry
      ? {
          ...c,
          verdict: confinementFailed(retry) ? "confinement_error" : retry.ok ? "flaky" : c.verdict,
          blocking: !retry.ok,
          result: retry,
          firstAttempt: c.result,
        }
      : c;
  });
}
