import { expect, test } from "bun:test";
import type { GateComparison, GateResult } from "../src/gates/run.ts";
import * as g from "../src/pipeline/run-transfer-gates.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { head, sha } from "./run-transfer-support.ts";

const json = (v: unknown): unknown => JSON.parse(new TextDecoder().decode(encodeTransferJson(v)));
const oid = (n: number) => n.toString(16).repeat(40);
const basic = (): GateResult => ({
  name: "test",
  command: "bun test",
  ok: false,
  exitCode: 1,
  durationMs: 1.5,
  output: oid(9),
});
function populated(): GateComparison {
  return {
    name: "test",
    verdict: "flaky",
    blocking: false,
    baselineConfinementError: true,
    postMergeWorker: null,
    retryProvenanceRejected: true,
    retryOriginal: { verdict: "targeted_failure", blocking: true },
    firstAttempt: { ...basic(), confinementError: true, executionProvenance: { sha: oid(6) } },
    coordinatorConfirmation: {
      worker: "worker",
      os: "linux",
      originalVerdict: "confinement_error",
      reason: "confirm",
      result: { ...basic(), retryAttempt: { ...basic(), ok: true, executionProvenance: { sha: oid(7) } } },
    },
    result: {
      ...basic(),
      ok: true,
      exitCode: 0,
      incomplete: "interrupted",
      timedOut: false,
      confinementError: false,
      failures: "original failure",
      failureAttributionComplete: false,
      failureAttributionReason: "unattributed",
      executedCommand: "bun test --reporter=junit",
      executor: { kind: "github-actions", workflowSha: oid(1), runsOn: "linux" },
      executionProvenance: { sha: oid(2), trackedClean: false, provenanceError: "unknown" },
      reused: { executionId: oid(10), treeHash: oid(11), createdAt: 23 },
      coveringTest: { file: "a.test.ts", name: "case", reason: "no matching test" },
      failedFiles: ["z.ts", "a.ts", "z.ts"],
      failedFileTimes: JSON.parse('{"__proto__":0.5,"constructor":1,"z.ts":2.5}'),
      docsOnly: {
        mode: "targeted",
        changedPaths: ["z.md", "a.md", "z.md"],
        files: ["z.ts", "z.ts"],
        reason: "selected",
      },
      testCoverage: {
        passedFiles: ["z.ts", "a.ts", "z.ts"],
        skippedFiles: ["a.ts"],
        skippedTests: [
          { file: "a.ts", name: "case", line: 7 },
          { file: "a.ts", name: "case" },
        ],
        skippedTestsIncomplete: true,
        summary: { passed: 3, failed: 1 },
      },
      firstAttempt: {
        ...basic(),
        timedOut: true,
        executionProvenance: { sha: oid(3) },
        firstAttempt: { ...basic(), confinementError: true },
      },
      targetedRetry: { ...basic(), executionProvenance: { sha: oid(4) } },
      retryAttempt: { ...basic(), ok: true, executionProvenance: { sha: oid(5) } },
    },
  };
}
test("gate runs and comparisons retain recursive failures, rejected successes and all evidence", () => {
  const comparison = g.parseTransferGateComparison(json(g.parseTransferGateComparison(populated())));
  expect(comparison).toEqual(populated());
  expect(comparison).toMatchObject({
    verdict: "flaky",
    blocking: false,
    coordinatorConfirmation: { result: { ok: false, retryAttempt: { ok: true } } },
    result: {
      firstAttempt: { ok: false, timedOut: true, firstAttempt: { confinementError: true } },
      targetedRetry: { ok: false },
      retryAttempt: { ok: true },
    },
  });
  expect(comparison.result.failedFiles).toEqual(["z.ts", "a.ts", "z.ts"]);
  expect(comparison.result.testCoverage?.skippedTests).toEqual([
    { file: "a.ts", name: "case", line: 7 },
    { file: "a.ts", name: "case" },
  ]);
  const run = g.parseTransferGateRun(
    json(
      g.parseTransferGateRun({
        sha,
        treeHash: oid(12),
        trackedClean: false,
        provenanceError: "inspection failed",
        setupOk: false,
        setup: [{ ...basic(), executionProvenance: { sha: oid(8) } }],
        checks: [comparison.result, basic()],
      }),
    ),
  );
  expect(run).toMatchObject({ setupOk: false, trackedClean: false, provenanceError: "inspection failed" });
  expect(run.setup).toEqual([{ ...basic(), executionProvenance: { sha: oid(8) } }]);
  expect(run.checks).toEqual([populated().result, basic()]);
  expect(new Set(g.gateRunCommitDependencies(run))).toEqual(new Set([sha, ...[1, 2, 3, 4, 5, 8].map(oid)]));
  expect(new Set(g.gateComparisonCommitDependencies(comparison))).toEqual(
    new Set([1, 2, 3, 4, 5, 6, 7].map(oid)),
  );
});

test("legacy uncertainty, explicit false flags and incomplete evidence never acquire defaults", () => {
  const result = g.parseTransferGateResult(json(g.parseTransferGateResult(basic())));
  for (const key of [
    "executor",
    "executionProvenance",
    "confinementError",
    "timedOut",
    "testCoverage",
    "reused",
  ])
    expect(Object.hasOwn(result, key)).toBe(false);
  for (const skippedTestsIncomplete of [undefined, false, true]) {
    const decoded = g.parseTransferGateResult(
      json(
        g.parseTransferGateResult({
          ...basic(),
          testCoverage: {
            passedFiles: [],
            skippedFiles: [],
            ...(skippedTestsIncomplete === undefined ? {} : { skippedTestsIncomplete }),
          },
        }),
      ),
    );
    expect(Object.hasOwn(decoded.testCoverage ?? {}, "skippedTestsIncomplete")).toBe(
      skippedTestsIncomplete !== undefined,
    );
    expect(decoded.testCoverage?.skippedTestsIncomplete).toBe(skippedTestsIncomplete);
  }
  const comparison = populated();
  delete comparison.postMergeWorker;
  delete comparison.coordinatorConfirmation?.result;
  const decoded = g.parseTransferGateComparison(json(g.parseTransferGateComparison(comparison)));
  expect(Object.hasOwn(decoded, "postMergeWorker")).toBe(false);
  expect(Object.hasOwn(decoded.coordinatorConfirmation ?? {}, "result")).toBe(false);
  expect(decoded.result).toMatchObject({
    confinementError: false,
    timedOut: false,
    failureAttributionComplete: false,
    testCoverage: { skippedTestsIncomplete: true },
    coveringTest: { reason: "no matching test" },
  });
  expect(g.parseTransferGateResult({ ...basic(), executionProvenance: {} }).executionProvenance).toEqual({});
  expect(g.parseTransferGateRun({ setupOk: true, setup: [], checks: [] })).toEqual({
    setupOk: true,
    setup: [],
    checks: [],
  });
});

test("grouped covering identities retain order through recursive retries", () => {
  const coveringTests = [
    { file: "a.test.ts", name: "second", reason: "test failed" },
    { file: "a.test.ts", name: "first" },
  ];
  const input: GateResult = {
    ...basic(),
    coveringTests,
    firstAttempt: { ...basic(), retryAttempt: { ...basic(), coveringTests } },
  };
  const decoded = g.parseTransferGateResult(json(g.parseTransferGateResult(input)));
  expect(decoded).toEqual(input);
  expect(decoded.coveringTests?.map((v) => v.name)).toEqual(["second", "first"]);
  expect(decoded.firstAttempt?.retryAttempt?.coveringTests).toEqual(coveringTests);
});

test.each([undefined, false, true])("covering report availability preserves %s", (reportUnavailable) => {
  const evidence = {
    file: "a.test.ts",
    name: "case",
    reason: "JUnit report missing",
    ...(reportUnavailable === undefined ? {} : { reportUnavailable }),
  };
  const decoded = g.parseTransferGateResult(
    json(
      g.parseTransferGateResult({
        ...basic(),
        coveringTest: evidence,
        retryAttempt: { ...basic(), coveringTests: [evidence] },
      }),
    ),
  );
  for (const record of [decoded.coveringTest, decoded.retryAttempt?.coveringTests?.[0]]) {
    expect(record).toEqual(evidence);
    expect(Object.hasOwn(record ?? {}, "reportUnavailable")).toBe(reportUnavailable !== undefined);
    expect(record?.reportUnavailable).toBe(reportUnavailable);
  }
});

test.each([
  { coveringTests: {} },
  { coveringTests: [{ file: "a.test.ts" }] },
  { coveringTests: [{ file: "a.test.ts", name: "case", unknown: true }] },
  ...[null, "true", 1].flatMap((reportUnavailable) => {
    const evidence = { file: "a.test.ts", name: "case", reportUnavailable };
    return [{ coveringTest: evidence }, { coveringTests: [evidence] }];
  }),
])("malformed covering evidence is sanitized", (evidence) => {
  expect(() => g.parseTransferGateResult({ ...basic(), ...evidence })).toThrow(
    expect.objectContaining({
      name: "RunTransferError",
      code: "invalid",
      message: "Run transfer data is invalid",
    }),
  );
});

test.each([
  ["result.unknown", true],
  ["unknown", "private-input"],
  ["verdict", "clean"],
  ["result.executor.workflowSha", "bad"],
  ["result.executionProvenance.sha", "bad"],
  ["result.reused.treeHash", "bad"],
  ["result.reused.executionId", ""],
  ["result.ok", 1],
  ["result.firstAttempt.retryAttempt", { ok: true }],
  ["result.targetedRetry.name", null],
  ["result.testCoverage.summary.failed", "0"],
  ["result.testCoverage.skippedTests.0.line", 0],
  ["result.testCoverage.skippedTests.1.unknown", true],
  ["result.testCoverage.skippedTestsIncomplete", null],
  ["result.docsOnly.mode", "fast"],
  ["result.docsOnly.unknown", true],
  ["result.coveringTest.unknown", true],
  ["result.failedFileTimes", { "a.ts": "1" }],
  ["coordinatorConfirmation.originalVerdict", "invalid"],
  ["coordinatorConfirmation.unknown", true],
  ["retryOriginal.unknown", true],
  ["result.durationMs", -1],
  ["result.exitCode", 0.5],
] as const)("malformed or unknown gate evidence %s is sanitized", (path, value) => {
  const input = populated();
  const keys = path.split(".");
  let parent: object = input;
  for (const key of keys.slice(0, -1)) parent = Reflect.get(parent, key);
  Reflect.set(parent, keys.at(-1) ?? path, value);
  expect(() => g.parseTransferGateComparison(input)).toThrow(
    expect.objectContaining({
      name: "RunTransferError",
      code: "invalid",
      message: "Run transfer data is invalid",
    }),
  );
});

test("gate boundaries reject unknown run fields and preserve SHA-256 OIDs", () => {
  expect(
    g.parseTransferGateResult({ ...basic(), executionProvenance: { sha: head } }).executionProvenance?.sha,
  ).toBe(head);
  for (const input of [
    { setupOk: true, setup: [], checks: [], unknown: true },
    { setupOk: true, checks: [] },
    { setupOk: true, setup: [], checks: [], treeHash: "bad" },
  ])
    expect(() => g.parseTransferGateRun(input)).toThrow(
      expect.objectContaining({ name: "RunTransferError", message: "Run transfer data is invalid" }),
    );
});
