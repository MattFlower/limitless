import { getPrivacyChecker } from "../util/privacy-checker.ts";
import { verifier } from "../util/privacy-proof.ts";
import { activity } from "../util/stall.ts";
import { terminalRedactor } from "../util/terminal-redaction.ts";
import type { GateComparison, GateResult } from "./run.ts";
import { attributionReason, gateIdentities, gatePrivacyScope, withheldText } from "./text-privacy.ts";

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
type ProjectionOptions = {
  mode: "durable" | "outward";
  registry?: Parameters<typeof verifier>[0];
  signer?: Parameters<typeof verifier>[1];
  maxEventData?: number;
};
const isResult = (v: unknown): v is GateResult =>
  !!v &&
  typeof v === "object" &&
  "ok" in v &&
  typeof Reflect.get(v, "command") === "string" &&
  typeof Reflect.get(v, "output") === "string";
const identities = new Set([
  "command",
  "executedCommand",
  "failedFiles",
  "failedFileTimes",
  "coveringTest",
  "coveringTests",
  "testCoverage",
]);
type Field = NonNullable<GateResult["textPrivacy"]>["output"];
type Project = (record: Field | undefined, key: "output" | "identities") => Field;
function projectResult(r: GateResult, field: Project): GateResult {
  const output = field(r.textPrivacy?.output, "output"),
    ids = field(r.textPrivacy?.identities, "identities");
  const out = {
    ...r,
    output: output.withheld
      ? withheldText(output.reason, r.output === withheldText(output.reason, true))
      : r.output,
    confinementError: r.confinementError ?? launchFailure(r.output),
    textPrivacy: { output, identities: ids },
  };
  delete out.failures;
  delete out.remoteAttestation;
  if (out.failureAttributionReason !== undefined)
    out.failureAttributionReason = attributionReason(out.failureAttributionReason);
  if (ids.withheld) {
    for (const key of identities) Reflect.deleteProperty(out, key);
    out.command = withheldText(ids.reason);
    if (r.testCoverage)
      out.testCoverage = {
        passedFiles: [],
        skippedFiles: [],
        skippedTestsIncomplete: true,
        summary: r.testCoverage.summary,
      };
  }
  return out;
}
const confirmationReasons = new Set([
  "worker execution attribution unavailable",
  "targeted retry returned no check result",
  "confinement failure",
  "confirmation timed out",
  "pass (worker-specific flake)",
  "failed on coordinator",
  "coordinator confirmation deadline expired (slot wait or execution)",
  "setup failures are not retried",
  "check does not match base configuration",
]);
/** Proofs are authority; shape recognition only selects the fields to project. */
export function projectGateDiagnostics<T>(value: T, options: ProjectionOptions): T {
  let snapshot: ReturnType<typeof verifier> | undefined;
  const results = new WeakSet<object>(),
    untouched = new WeakSet<object>();
  return redactData(
    value,
    function (key, v) {
      if (key === "textPrivacy" && v && typeof v === "object") {
        v = Object.fromEntries(
          Object.entries(v).map(([field, record]) => {
            if (!record || typeof record !== "object") return [field, record];
            const { mac, ...claim } = record;
            return [field, options.mode === "outward" ? claim : record];
          }),
        );
        untouched.add(Object(v));
        return v;
      }
      if (key === "provenanceError" || key === "remoteAttestation") return undefined;
      const preserved = key !== "summary" && untouched.has(this);
      if (preserved || (results.has(this) && (key === "output" || identities.has(key)))) {
        if (v && typeof v === "object") untouched.add(v);
        return v;
      }
      if (isResult(v)) {
        const scope = gatePrivacyScope.getStore();
        snapshot ??= verifier(
          options.registry ?? scope?.registry ?? getPrivacyChecker().registry,
          options.signer ?? scope?.signer,
        );
        const r = v;
        v = projectResult(r, (record, field) => {
          if (record?.withheld === true) return record;
          const bytes = field === "output" ? r.output : gateIdentities(r);
          if (!record || !snapshot?.verify(record, field, bytes))
            return { withheld: true, reason: "unproven" };
          return redactGateOutput(bytes) === bytes
            ? record
            : { withheld: true, reason: "credential-changed" };
        });
        results.add(Object(v));
        return v;
      }
      if (v && typeof v === "object" && "originalVerdict" in v && "reason" in v)
        return {
          ...v,
          reason: confirmationReasons.has(String(v.reason)) ? v.reason : withheldText("unproven"),
        };
      return passthrough;
    },
    (serialized) =>
      JSON.parse(
        serialized,
        options.maxEventData !== undefined && serialized.length > options.maxEventData
          ? (_key, v: unknown) =>
              isResult(v)
                ? projectResult(v, (record) =>
                    record?.withheld ? record : { withheld: true, reason: "event-size" },
                  )
                : v
          : undefined,
      ),
  );
}
const passthrough = Symbol();
type Replacer = (this: object, key: string, value: unknown) => unknown;
const redactData = <T>(value: T, project?: Replacer, parse = JSON.parse): T =>
  value === undefined
    ? value
    : parse(
        JSON.stringify(value, function (key, v: unknown) {
          if (project) {
            const next = project.call(this, key, v);
            if (next !== passthrough) return next;
          }
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
  ...(result.executedCommand ? { executedCommand: redactGateOutput(result.executedCommand) } : {}),
  ...(result.coveringTest ? { coveringTest: redactGateData(result.coveringTest) } : {}),
  ...(result.failureAttributionReason !== undefined
    ? { failureAttributionReason: redactGateOutput(result.failureAttributionReason) }
    : {}),
  ...(result.testCoverage ? { testCoverage: redactGateData(result.testCoverage) } : {}),
  ...(result.failures !== undefined ? { failures: redactGateOutput(result.failures) } : {}),
  ...(result.executionProvenance ? { executionProvenance: redactGateData(result.executionProvenance) } : {}),
  ...(result.targetedRetry ? { targetedRetry: redactGateDiagnostics(result.targetedRetry) } : {}),
  ...(result.retryAttempt ? { retryAttempt: redactGateDiagnostics(result.retryAttempt) } : {}),
  ...(result.firstAttempt ? { firstAttempt: redactGateDiagnostics(result.firstAttempt) } : {}),
});

/** Runner redaction covers accidental disclosure before framing or cuts. Deliberate cross-stream
 * splitting, interleaving or encoding requires keeping credentials out of gates' reach (#335). */
export function redactGateStreams(stdout: string, stderr: string) {
  return { stdout: redactGateOutput(stdout), stderr: redactGateOutput(stderr) };
}

/** Decode JSON before sanitizing escaped credentials and terminal controls. */
export function sanitizeArtifact(name: string, content: string): string {
  return name.endsWith(".json")
    ? JSON.stringify(redactGateData(JSON.parse(content)), null, content.includes("\n") ? 2 : undefined)
    : redactGateOutput(content);
}
