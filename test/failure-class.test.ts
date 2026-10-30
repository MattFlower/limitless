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
    expect(classifyObservation({ confinement, setup_eligible, timed_out, history }, c).class).toBe(expected);
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

test.each([
  ["retry_passed", 1, "linux", "darwin", "load", undefined],
  ["confirmed_passed", 1, "linux", "darwin", "platform", undefined],
  ["confirmed_passed", 0, "darwin", "darwin", "flaky", undefined],
  ["confirmed_passed", 0, null, "darwin", "unclassified", "worker OS unknown"],
  ["confirmed_passed", 0, "linux", undefined, "unclassified", "worker OS unknown"],
  ["confirmed_failed", 1, "linux", "darwin", "regression", undefined],
  ["confirmation_unavailable", 1, "linux", "darwin", "unclassified", "deadline expired"],
] as const)(
  "confirmation classification %s slow=%s worker=%s coordinator=%s",
  (history, slow_regression, os, coordinatorOs, cls, reason) => {
    const c = comparison("regressed");
    c.coordinatorConfirmation = {
      originalVerdict: "regressed",
      reason: "deadline expired",
      os: coordinatorOs,
    };
    const o = { confinement: 0, setup_eligible: 0, timed_out: 1, history, slow_regression, os };
    expect(classifyObservation(o, c)).toEqual(reason ? { class: cls, reason } : { class: cls });
    expect(classifyObservation({ ...o, confinement: 1 }, c)).toEqual({ class: "confinement" });
    expect(classifyObservation({ ...o, setup_eligible: 1 }, c)).toEqual({ class: "setup" });
  },
);

test.each(["pass", "fail", "timeout", "confinement", "unavailable", "rejected", "rejected result"])(
  "confirmation history: %s",
  (scenario) => {
    const c = comparison("regressed");
    c.retryOriginal = { verdict: "regressed", blocking: true };
    c.coordinatorConfirmation = {
      originalVerdict: "regressed",
      reason: "confirmation evidence",
      result:
        scenario === "unavailable"
          ? undefined
          : {
              ...c.result,
              ok: scenario === "pass",
              timedOut: scenario === "timeout",
              confinementError: scenario === "confinement",
            },
    };
    c.retryProvenanceRejected = scenario === "rejected";
    if (scenario === "rejected result") c.result.retryAttempt = { ...c.result, ok: true };
    expect(observationHistory(c)).toBe(
      scenario.startsWith("rejected")
        ? "retry_rejected"
        : scenario === "pass"
          ? "confirmed_passed"
          : scenario === "fail"
            ? "confirmed_failed"
            : "confirmation_unavailable",
    );
  },
);
