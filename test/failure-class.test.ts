import { expect, test } from "bun:test";
import { classifyObservation, type FailureHistory, observationHistory } from "../src/gates/failure-class.ts";
import type { GateComparison, GateVerdict } from "../src/gates/run.ts";

const comparison = (verdict: GateVerdict): GateComparison => ({
  name: "test",
  verdict,
  blocking: false,
  result: { name: "test", command: "bun test", ok: false, exitCode: 1, durationMs: 1, output: "failed" },
});

test.each([
  [1, 1, 1, "rerun_passed", "pass", "confinement"],
  [0, 1, 1, "retry_passed", "flaky", "setup"],
  [0, 0, 1, "rerun_passed", "pass", "load"],
  [0, 0, 1, "retry_passed", "pass", "load"],
  [0, 0, 1, "rerun_failed", "regressed", "unclassified"],
  [0, 0, 1, "no_retry", "still_failing", "unclassified"],
  [0, 0, 0, "retry_passed", "flaky", "flaky"],
  [0, 0, 0, "retry_rejected", "regressed", "regression"],
  [0, 0, 0, "no_retry", "targeted_failure", "regression"],
  [0, 0, 0, "retry_failed", "regressed", "regression"],
  [0, 0, 0, "no_retry", "still_failing", "base_failure"],
  [0, 0, 0, "retry_failed", "new_failure", "unclassified"],
  [0, 0, 0, "no_retry", "pass", "unclassified"],
  [0, 0, 0, "retry_rejected", "new_failure", "unclassified"],
  [0, 0, 0, "interrupted", "regressed", "unclassified"],
  [0, 0, 0, "no_retry", "confinement_error", "confinement"],
] as const)(
  "classification: confinement=%s setup=%s timeout=%s history=%s verdict=%s → %s",
  (confinement, setup_eligible, timed_out, history, verdict, expected) => {
    const c = comparison(verdict);
    c.retryOriginal = { verdict, blocking: true };
    expect(classifyObservation({ confinement, setup_eligible, timed_out, history }, c)).toBe(expected);
  },
);

test.each([
  "no_retry",
  "retry_failed",
  "retry_passed",
  "retry_rejected",
  "rerun_passed",
  "rerun_failed",
] as FailureHistory[])("derive %s from comparison evidence", (history) => {
  const c = comparison("regressed");
  c.result.ok = history.endsWith("passed");
  if (history.startsWith("retry_")) c.retryOriginal = { verdict: "regressed", blocking: true };
  if (history.startsWith("rerun_")) c.result.firstAttempt = { ...c.result, ok: false, timedOut: true };
  if (history === "retry_rejected") c.retryProvenanceRejected = true;
  expect(observationHistory(c)).toBe(history);
  if (c.result.ok) expect(observationHistory(c, true)).toBe("retry_passed");
});
