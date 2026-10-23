import type { QuotaWindow } from "../../src/core/types.ts";

/** Severity class for a quota gauge's fill: amber from 70% used, red from 90%. */
export function gaugeClass(utilization: number): string {
  if (utilization >= 0.9) return "crit";
  if (utilization >= 0.7) return "warn";
  return "";
}

/** A reset or an hour without an observation makes the utilization bar misleading. */
export function quotaWindowFresh(window: QuotaWindow & { observedAt?: number | null }, now: number): boolean {
  return (
    (window.resetsAt == null || window.resetsAt > now) &&
    window.observedAt != null &&
    now - window.observedAt < 60 * 60 * 1000
  );
}
