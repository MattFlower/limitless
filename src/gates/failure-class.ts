import { confinementFailed, type GateComparison } from "./run.ts";

export type FailureClass =
  | "confinement"
  | "setup"
  | "undeclared_requirement"
  | "load"
  | "platform"
  | "flaky"
  | "regression"
  | "base_failure"
  | "unclassified";
export type FailureHistory =
  | "no_retry"
  | "retry_failed"
  | "retry_passed"
  | "retry_rejected"
  | "rerun_passed"
  | "rerun_failed"
  | "confirmed_passed"
  | "confirmed_failed"
  | "confirmation_unavailable"
  | "interrupted";
type Attempt = {
  slow_regression?: number;
  os?: string | null;
  confinement: number;
  setup_eligible: number;
  timed_out: number;
  history: FailureHistory | null;
};

export function observationHistory(c?: GateComparison, earlierStage = false): FailureHistory {
  if (!c) return "no_retry";
  const passed = c.result.ok && !c.result.timedOut;
  if (earlierStage && passed) return "retry_passed";
  if (c.retryProvenanceRejected || (c.coordinatorConfirmation && c.result.retryAttempt?.ok))
    return "retry_rejected";
  if (c.coordinatorConfirmation) {
    const r = c.coordinatorConfirmation.result;
    return !r || r.timedOut || confinementFailed(r)
      ? "confirmation_unavailable"
      : r.ok
        ? "confirmed_passed"
        : "confirmed_failed";
  }
  if (c.retryOriginal)
    return c.result.retryAttempt?.ok ? "retry_rejected" : passed ? "retry_passed" : "retry_failed";
  if (c.result.firstAttempt?.timedOut || c.firstAttempt?.timedOut)
    return passed ? "rerun_passed" : "rerun_failed";
  return "no_retry";
}

export function classifyObservation(
  o: Attempt,
  c?: GateComparison,
): { class: FailureClass; reason?: string } {
  const cls = classify(o, c);
  const reason =
    cls !== "unclassified"
      ? undefined
      : o.history === "confirmed_passed"
        ? "worker OS unknown"
        : o.history === "confirmation_unavailable"
          ? c?.coordinatorConfirmation?.reason
          : undefined;
  return reason === undefined ? { class: cls } : { class: cls, reason };
}
function classify(o: Attempt, c?: GateComparison): FailureClass {
  if (o.confinement || c?.verdict === "confinement_error") return "confinement";
  if (o.setup_eligible) return "setup";
  if (o.slow_regression && o.history === "retry_passed") return "load";
  if (o.history === "confirmed_passed") {
    const os = c?.coordinatorConfirmation?.os;
    return !o.os || !os ? "unclassified" : o.os === os ? "flaky" : "platform";
  }
  if (o.history === "confirmed_failed") return "regression";
  if (o.history === "confirmation_unavailable") return "unclassified";
  if (o.timed_out)
    return o.history === "rerun_passed" || o.history === "retry_passed" ? "load" : "unclassified";
  if (o.history === "retry_passed") return "flaky";
  const regression = (verdict?: string) => verdict === "regressed" || verdict === "targeted_failure";
  if (o.history === "retry_rejected")
    return regression(c?.retryOriginal?.verdict) ? "regression" : "unclassified";
  if (regression(c?.verdict) && (o.history === "no_retry" || o.history === "retry_failed"))
    return "regression";
  return c?.verdict === "still_failing" ? "base_failure" : "unclassified";
}
