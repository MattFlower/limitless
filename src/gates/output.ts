import { activity } from "../util/stall.ts";
import { terminalRedactor } from "../util/terminal-redaction.ts";
import type { GateComparison, GateResult } from "./run.ts";

/** Describe limited test evidence consistently in reports and model prompts. */
export function docsGateSummary(check: GateComparison): string | undefined {
  const docs = check.result.docsOnly;
  if (docs?.mode === "skipped") return `not run (${docs.reason})`;
  if (docs?.mode !== "targeted" && !check.verdict.startsWith("targeted_")) return undefined;
  const verdict =
    check.verdict === "confinement_error"
      ? "targeted confinement error"
      : check.result.timedOut
        ? "targeted failure (timed out)"
        : check.verdict === "flaky"
          ? "targeted pass (flaky)"
          : check.result.ok
            ? "targeted pass"
            : "targeted failure";
  const files = docs?.files ?? [];
  return `${verdict} (${files.length} test file${files.length === 1 ? "" : "s"}; ${docs?.reason ?? "targeted check"}; full suite didn't run; ${files.join(", ")})`;
}

const LAUNCH_FAILURE = "sandbox_apply: Operation not permitted";
export const launchFailure = (output: string) => output.includes(LAUNCH_FAILURE);

/** Scan raw streams independently so redaction and terminal normalization cannot alter the verdict. */
export function launchFailureScan() {
  const pending = { stdout: "", stderr: "" };
  let failed = false;
  return {
    observe(chunk: string, stream: "stdout" | "stderr") {
      const text = pending[stream] + chunk;
      failed ||= launchFailure(text);
      pending[stream] = text.slice(-(LAUNCH_FAILURE.length - 1));
    },
    failed: () => failed,
  };
}

/** Remove terminal formatting while redacting, before any diagnostic or tail cuts; a whole value equal
 * to a short credential is still redacted. */
export const redactGateOutput = (output: string): string => terminalRedactor().push(output, true);

/** Prefer literal identity; sanitized stored names are usable only without collisions on either side. */
export function findGateCounterpart<T extends { name: string }>(
  gate: { name: string },
  own: readonly { name: string }[],
  other: readonly T[],
): T | undefined {
  const exact = other.find((entry) => entry.name === gate.name);
  if (exact) return exact;
  const name = redactGateOutput(gate.name);
  if (own.filter((entry) => redactGateOutput(entry.name) === name).length !== 1) return undefined;
  const matches = other.filter((entry) => redactGateOutput(entry.name) === name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Sanitize decoded historical data without changing rows; preserve the raw confinement verdict. */
export const redactGateData = <T>(value: T): T => activity("gates.redact", () => redactData(value));
const redactData = <T>(value: T): T =>
  value === undefined
    ? value
    : JSON.parse(
        JSON.stringify(value, (key, v: unknown) => {
          if (key === "failedFileTimes" && v && typeof v === "object")
            return Object.fromEntries(
              Object.entries(v).map(([file, time]) => [redactGateOutput(file), time]),
            );
          if (
            v &&
            typeof v === "object" &&
            "skippedTests" in v &&
            Array.isArray(v.skippedTests) &&
            v.skippedTests.some(
              (skip: unknown) =>
                skip &&
                typeof skip === "object" &&
                "file" in skip &&
                typeof skip.file === "string" &&
                "name" in skip &&
                typeof skip.name === "string" &&
                (redactGateOutput(skip.file) !== skip.file || redactGateOutput(skip.name) !== skip.name),
            )
          )
            return { ...v, skippedTestsIncomplete: true };
          if (typeof v === "string") return redactGateOutput(v);
          if (v && typeof v === "object" && "ok" in v && "output" in v && typeof v.output === "string") {
            if ("confinementError" in v && v.confinementError != null) return v;
            return { ...v, confinementError: launchFailure(v.output) };
          }
          return v;
        }),
      );

/** Reload a known gate result without rewriting executable inputs or comparison identities. */
export const redactGateDiagnostics = <T extends GateResult>(result: T): T => ({
  ...result,
  confinementError: result.confinementError ?? launchFailure(result.output),
  output: redactGateOutput(result.output),
  ...(result.failureAttributionReason !== undefined
    ? { failureAttributionReason: redactGateOutput(result.failureAttributionReason) }
    : {}),
  ...(result.testCoverage ? { testCoverage: redactGateData(result.testCoverage) } : {}),
  ...(result.failures !== undefined ? { failures: redactGateOutput(result.failures) } : {}),
  ...(result.firstAttempt ? { firstAttempt: redactGateDiagnostics(result.firstAttempt) } : {}),
});

/** Runner redaction covers accidental disclosure before framing or cuts. Deliberate cross-stream
 * splitting, interleaving or encoding requires keeping credentials out of gates' reach (#335). */
export function redactGateStreams(stdout: string, stderr: string) {
  return { stdout: redactGateOutput(stdout), stderr: redactGateOutput(stderr) };
}
