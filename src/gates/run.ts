import { agentEnv, runProcess } from "../util/proc.ts";
import type { GateCommand, GateConfig } from "./detect.ts";

export interface GateResult {
  name: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string; // tail
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
  | "not_run";

export interface GateComparison {
  name: string;
  verdict: GateVerdict;
  blocking: boolean;
  result: GateResult;
}

const OUTPUT_TAIL = 6_000;

async function runOne(cmd: GateCommand, cwd: string, signal: AbortSignal): Promise<GateResult> {
  const res = await runProcess({
    cmd: ["/bin/sh", "-c", cmd.run],
    cwd,
    // Gates execute code the agent wrote; give them the same scrubbed environment as agents.
    env: agentEnv({ CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" }),
    signal,
    timeoutMs: (cmd.timeoutSec ?? 900) * 1000,
  });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  return {
    name: cmd.name,
    command: cmd.run,
    ok: res.exitCode === 0 && !res.timedOut && !res.cancelled,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
    output: (res.timedOut ? "[timed out]\n" : "") + combined.slice(-OUTPUT_TAIL),
  };
}

export async function runGates(
  cwd: string,
  cfg: GateConfig,
  signal: AbortSignal,
  onResult?: (r: GateResult, phase: "setup" | "check") => void,
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

/** Compare post-change gates with the baseline taken on the untouched base branch. */
export function compareGates(baseline: GateRun | null, after: GateRun): GateComparison[] {
  const out: GateComparison[] = [];
  if (!after.setupOk) {
    // Nothing downstream ran, so nothing was verified: always blocking, even if setup was
    // already broken on the base branch.
    const failed = after.setup.find((s) => !s.ok);
    if (failed) out.push({ name: failed.name, verdict: "regressed", blocking: true, result: failed });
    const skipped = baseline?.checks ?? [];
    for (const c of skipped) {
      out.push({
        name: c.name,
        verdict: "not_run",
        blocking: true,
        result: { ...c, ok: false, exitCode: null, durationMs: 0, output: "not run: setup failed" },
      });
    }
    return out;
  }
  for (const r of after.checks) {
    const before = baseline?.checks.find((b) => b.name === r.name);
    let verdict: GateVerdict;
    if (!before) verdict = r.ok ? "new_pass" : "new_failure";
    else if (before.ok && r.ok) verdict = "pass";
    else if (before.ok && !r.ok) verdict = "regressed";
    else if (!before.ok && r.ok) verdict = "fixed";
    else verdict = "still_failing";
    out.push({
      name: r.name,
      verdict,
      blocking: verdict === "regressed" || verdict === "new_failure",
      result: r,
    });
  }
  return out;
}
