import { basename } from "node:path";
import { runConfined, withCommandScratch } from "../harness/sandbox.ts";
import { agentEnv } from "../util/proc.ts";
import type { GateCommand, GateConfig } from "./detect.ts";
import { gateSlots } from "./slots.ts";

export interface GateResult {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string; // tail
  /** Set only when the process was killed for exceeding its timeout. */
  timedOut?: boolean;
  confinementError?: boolean;
  /** The first attempt of a check that was re-run; this result is the re-run. */
  firstAttempt?: GateResult;
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
  onResult?: (r: GateResult, phase: "setup" | "check") => void;
  /** Fires once when every gate slot is busy and this call has to queue. */
  onWait?: (slots: number) => void;
}

const OUTPUT_TAIL = 6_000;
const launchFailure = (output: string) => output.includes("sandbox_apply: Operation not permitted");
const confinementFailed = (r?: GateResult): boolean =>
  !!r && (!!r.confinementError || launchFailure(r.output) || confinementFailed(r.firstAttempt));

/** Gates execute code the agent wrote; give them the same scrubbed environment as agents. */
export const gateEnv = (): Record<string, string> => agentEnv({ CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" });

/** Gates run confined to the checkout; a ConfinementError propagates so it can never grade a check. */
async function runOne(cmd: GateCommand, cwd: string, signal: AbortSignal): Promise<GateResult> {
  let confinementError = false;
  const observe = (line: string) => (confinementError ||= launchFailure(line));
  const res = await runConfined({
    command: cmd.run,
    cwd,
    env: gateEnv(),
    signal,
    timeoutMs: (cmd.timeoutSec ?? 900) * 1000,
    onStdoutLine: observe,
    onStderrLine: observe,
  });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  return {
    name: cmd.name,
    command: cmd.run,
    ok: !confinementError && res.exitCode === 0 && !res.timedOut && !res.cancelled,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    output: (res.timedOut ? "[timed out]\n" : "") + combined.slice(-OUTPUT_TAIL),
    ...(res.timedOut ? { timedOut: true } : {}),
    // Present only when set, like timedOut, so results stay readable by strict schemas and older releases.
    ...(confinementError ? { confinementError: true } : {}),
  };
}

/** Run setup and checks inside one machine-wide gate slot. */
export async function runGates(
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  hooks: GateHooks = {},
): Promise<GateRun> {
  const release = await gateSlots.acquire(signal, hooks.onWait);
  try {
    return await withCommandScratch(cwd, () => runAll(cwd, cfg, signal, hooks.onResult));
  } finally {
    release();
  }
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
): Promise<GateRun> {
  const retryable = (r: GateResult) =>
    !r.ok && !r.timedOut && !confinementFailed(r)
      ? cfg.checks.find((k) => k.name === r.name && k.run === r.command)
      : undefined;
  if (!run.setupOk || signal.aborted || !run.checks.some(retryable)) return run;
  const release = await gateSlots.acquire(signal, onWait);
  try {
    const checks: GateResult[] = [];
    for (const r of run.checks) {
      const check = retryable(r);
      if (!check || signal.aborted) {
        checks.push(r);
        continue;
      }
      const retry = await runOne(check, cwd, signal);
      checks.push({ ...retry, firstAttempt: r });
    }
    return { ...run, checks };
  } finally {
    release();
  }
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
): Promise<GateComparison[]> {
  // Matching the command too keeps a failed setup step (also "regressed") from being retried.
  const retryable = (c: GateComparison) =>
    c.verdict === "regressed" && !c.result.timedOut && !pointsAt(c.result.output, changed)
      ? cfg.checks.find((k) => k.name === c.name && k.run === c.result.command)
      : undefined;
  if (!cmp.some(retryable)) return cmp;
  const release = await gateSlots.acquire(signal, onWait);
  try {
    const out: GateComparison[] = [];
    for (const c of cmp) {
      const check = retryable(c);
      if (!check || signal.aborted) {
        out.push(c);
        continue;
      }
      const retry = await runOne(check, cwd, signal);
      out.push({
        ...c,
        verdict: confinementFailed(retry) ? "confinement_error" : retry.ok ? "flaky" : c.verdict,
        blocking: !retry.ok,
        result: retry,
        firstAttempt: c.result,
      });
    }
    return out;
  } finally {
    release();
  }
}
