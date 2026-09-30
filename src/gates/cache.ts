import { createHash } from "node:crypto";
import type { GateConfig } from "./detect.ts";
import type { GateResult, GateRun } from "./run.ts";

/** Bump whenever how gates execute changes (environment, retries, result shape): old entries then miss. */
export const GATE_ENV_VERSION = 1;
export const BASELINE_CACHE_TTL_MS = 7 * 86_400_000;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}

/** Key-order-independent hash of the gate configuration detected from the base commit. */
export function gatesHash(cfg: GateConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(cfg)))
    .digest("hex");
}

function finished(r: GateResult): boolean {
  return r.exitCode !== null && !r.timedOut && (!r.firstAttempt || finished(r.firstAttempt));
}

/**
 * Whether a baseline ran to completion: setup passed and every configured check ran to an exit
 * code (a check may fail). Timeouts, kills and partial check lists are never cached.
 */
export function cacheableBaseline(run: GateRun, cfg: GateConfig): boolean {
  return (
    run.setupOk &&
    run.setup.length === cfg.setup.length &&
    run.checks.length === cfg.checks.length &&
    run.checks.every((c, i) => c.name === cfg.checks[i]?.name && c.command === cfg.checks[i]?.run) &&
    [...run.setup, ...run.checks].every(finished)
  );
}
