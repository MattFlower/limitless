import { z } from "zod";
import type { GateComparison, GateResult, GateRun } from "../gates/run.ts";
import * as r from "./run-transfer-rows.ts";

const object = z.strictObject;
const text = z.string();
const strings = z.array(text);
const flag = z.boolean().optional();
const duration = z.number().nonnegative();
// Zod records omit reserved keys such as constructor; retain every dictionary entry.
export const transferDictionary = <T>(item: z.ZodType<T>) =>
  z.custom<Record<string, T>>(
    (v) =>
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.values(v).every((entry) => item.safeParse(entry).success),
  );
export const transferTestCoverageSchema = object({
  passedFiles: strings,
  skippedFiles: strings,
  skippedTests: z.array(object({ file: text, name: text, line: r.ordinal.optional() })).optional(),
  skippedTestsIncomplete: flag,
  summary: object(r.fields("passed failed", r.counter)).optional(),
});
export const transferDocsSelectionSchema = object({
  mode: r.oneOf("full targeted skipped"),
  changedPaths: strings,
  files: strings,
  reason: text,
});
export const transferCoveringTestEvidenceSchema = object({
  file: text,
  name: text,
  reason: text.optional(),
  reportUnavailable: flag,
});
const provenance = {
  sha: r.oid.optional(),
  trackedClean: flag,
  provenanceError: text.optional(),
};
export const transferGateResultSchema: z.ZodType<GateResult> = z.lazy(() =>
  object({
    executor: object({ kind: z.literal("github-actions"), workflowSha: r.oid, runsOn: text }).optional(),
    incomplete: text.optional(),
    coveringTest: transferCoveringTestEvidenceSchema.optional(),
    coveringTests: z.array(transferCoveringTestEvidenceSchema).optional(),
    executedCommand: text.optional(),
    executionProvenance: object(provenance).optional(),
    reused: object({ executionId: r.identity, treeHash: r.oid, createdAt: r.counter }).optional(),
    name: text,
    command: text,
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    durationMs: duration,
    output: text,
    failures: text.optional(),
    timedOut: flag,
    confinementError: flag,
    testCoverage: transferTestCoverageSchema.optional(),
    failedFiles: strings.optional(),
    failedFileTimes: transferDictionary(duration).optional(),
    failureAttributionComplete: flag,
    failureAttributionReason: text.optional(),
    docsOnly: transferDocsSelectionSchema.optional(),
    ...r.fields("firstAttempt targetedRetry retryAttempt", transferGateResultSchema.optional()),
  }),
);
export const transferGateRunSchema = object({
  ...provenance,
  treeHash: r.oid.optional(),
  setupOk: z.boolean(),
  setup: z.array(transferGateResultSchema),
  checks: z.array(transferGateResultSchema),
});
const verdict = r.oneOf(
  "pass targeted_pass targeted_failure fixed regressed still_failing new_failure new_pass not_run flaky confinement_error",
);
export const transferGateComparisonSchema = object({
  name: text,
  verdict,
  blocking: z.boolean(),
  result: transferGateResultSchema,
  baselineConfinementError: flag,
  postMergeWorker: text.nullable().optional(),
  coordinatorConfirmation: object({
    ...r.fields("worker os", text.optional()),
    originalVerdict: verdict,
    reason: text,
    result: transferGateResultSchema.optional(),
  }).optional(),
  retryProvenanceRejected: flag,
  retryOriginal: object({ verdict, blocking: z.boolean() }).optional(),
  firstAttempt: transferGateResultSchema.optional(),
});
export const parseTransferGateResult = r.boundary((value: unknown) =>
  r.parseRecord(transferGateResultSchema, value),
);
export const parseTransferGateRun = r.boundary((value: unknown) =>
  r.parseRecord(transferGateRunSchema, value),
);
export const parseTransferGateComparison = r.boundary((value: unknown) =>
  r.parseRecord(transferGateComparisonSchema, value),
);

// Semantic commit members only; treeHash and executionId are never commit dependencies.
// Follow every recursive edge, including rejected successful retries and confirmations.
export function gateResultCommitDependencies(value: GateResult): string[] {
  return [
    ...[value.executionProvenance?.sha, value.executor?.workflowSha].filter(
      (v): v is string => v !== undefined,
    ),
    ...[value.firstAttempt, value.targetedRetry, value.retryAttempt].flatMap((v) =>
      v ? gateResultCommitDependencies(v) : [],
    ),
  ];
}
export const gateRunCommitDependencies = (value: GateRun): string[] => [
  ...(value.sha === undefined ? [] : [value.sha]),
  ...[...value.setup, ...value.checks].flatMap(gateResultCommitDependencies),
];
export const gateComparisonCommitDependencies = (value: GateComparison): string[] =>
  [value.result, value.firstAttempt, value.coordinatorConfirmation?.result].flatMap((v) =>
    v ? gateResultCommitDependencies(v) : [],
  );
