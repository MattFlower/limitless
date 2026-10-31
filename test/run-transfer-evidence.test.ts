import { expect, test } from "bun:test";
import * as e from "../src/pipeline/run-transfer-evidence.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { encodeRunTransferRows } from "../src/pipeline/run-transfer-rows.ts";
import { fixture, head, rejects, repo, sha } from "./run-transfer-support.ts";

const stages = fixture().stages;
const portable = encodeRunTransferRows(fixture(), repo).stages;
const result = {
  name: "test",
  command: sha,
  ok: false,
  exitCode: null,
  output: head,
  durationMs: 0,
  executionProvenance: { sha },
  reused: { treeHash: "c".repeat(40), executionId: "d".repeat(40), createdAt: 1 },
};
const comparison = { name: "test", verdict: "targeted_failure" as const, blocking: true, result };
function input() {
  return {
    lastGates: [comparison],
    preRebaseGates: [{ ...comparison, verdict: "confinement_error", postMergeWorker: null }],
    gateEvidence: {
      stageId: 900,
      sha,
      baseSha: head,
      changedFiles: ["z.ts", "a.ts", "z.ts"],
      checks: [
        { ...comparison, testCommand: null },
        { ...comparison, testCommand: "bun test" },
      ],
    },
    coveringTestRuns: [
      {
        file: "a.ts",
        name: "case",
        verifiedSha: head,
        round: 31,
        stageId: 31,
        result,
        command: "bun test a.ts",
        reason: "incomplete",
      },
      { file: "a.ts", name: "case", verifiedSha: head, round: 900, stageId: 900 },
    ],
    postMergeGates: { sha, base: head, head: sha, round: 900, deadline: 31 },
  };
}
const roundTrip = (v: unknown) =>
  e.parseTransferEvidence(
    JSON.parse(new TextDecoder().decode(encodeTransferJson(e.encodeTransferEvidence(v, stages)))),
    portable,
  );
test("all five fragments retain portable shared stage references, order and incomplete post-merge attempts", () => {
  const value = roundTrip(input());
  expect(value.gateEvidence).toEqual({
    stageOrdinal: 2,
    sha,
    baseSha: head,
    changedFiles: ["z.ts", "a.ts", "z.ts"],
    checks: [
      { ...comparison, testCommand: null },
      { ...comparison, testCommand: "bun test" },
    ],
  });
  expect(value.coveringTestRuns?.map((v) => [v.stageOrdinal, v.round])).toEqual([
    [1, 31],
    [2, 900],
  ]);
  expect(value.coveringTestRuns?.[0]).toMatchObject({
    file: "a.ts",
    name: "case",
    result,
    command: "bun test a.ts",
    reason: "incomplete",
    verifiedSha: head,
  });
  expect(Object.hasOwn(value.coveringTestRuns?.[1] ?? {}, "result")).toBe(false);
  expect(value.lastGates).toEqual([comparison]);
  expect(value.preRebaseGates).toEqual([
    { ...comparison, verdict: "confinement_error", postMergeWorker: null },
  ]);
  expect(value.postMergeGates).toEqual({ sha, base: head, head: sha, round: 900, deadline: 31 });
  expect(Object.hasOwn(value.postMergeGates ?? {}, "result")).toBe(false);
  expect(new Set(e.evidenceCommitDependencies(value))).toEqual(new Set([sha, head]));
});

test("completed post-merge results preserve missing workers separately from null and explicit false", () => {
  for (const workers of [undefined, JSON.parse('{"test":null,"__proto__":"worker","constructor":null}')]) {
    const value = roundTrip({
      ...input(),
      postMergeGates: {
        ...input().postMergeGates,
        result: {
          setupOk: false,
          timedOut: false,
          comparison: [comparison],
          ...(workers === undefined ? {} : { workers }),
        },
      },
    });
    expect(value.postMergeGates?.result).toEqual({
      setupOk: false,
      timedOut: false,
      comparison: [comparison],
      ...(workers === undefined ? {} : { workers }),
    });
    expect(Object.hasOwn(value.postMergeGates?.result ?? {}, "workers")).toBe(workers !== undefined);
  }
  expect(e.parseTransferEvidence({}, [])).toEqual({});
});

test("each semantic commit field contributes dependencies through every evidence family", () => {
  const oid = (n: number) => n.toString(16).padStart(40, "0");
  const check = (n: number) => ({
    ...comparison,
    result: {
      ...result,
      retryAttempt: { ...result, executor: { kind: "github-actions", workflowSha: oid(n), runsOn: "linux" } },
    },
  });
  const value = roundTrip({
    lastGates: [check(1)],
    preRebaseGates: [check(2)],
    gateEvidence: {
      ...input().gateEvidence,
      sha: oid(3),
      baseSha: oid(4),
      checks: [{ ...check(5), testCommand: null }],
    },
    coveringTestRuns: [{ ...input().coveringTestRuns[0], verifiedSha: oid(6), result: check(7).result }],
    postMergeGates: {
      ...input().postMergeGates,
      sha: oid(8),
      base: oid(9),
      head: oid(10),
      result: { setupOk: true, timedOut: false, comparison: [check(11)] },
    },
  });
  expect(new Set(e.evidenceCommitDependencies(value))).toEqual(
    new Set([sha, ...Array.from({ length: 11 }, (_, i) => oid(i + 1))]),
  );
});

test.each([
  { baseline: {} },
  { baselineCached: false },
  { unknown: true },
  { gateEvidence: { ...input().gateEvidence, stageId: 404 } },
  { gateEvidence: { ...input().gateEvidence, stageId: 0 } },
  { gateEvidence: { ...input().gateEvidence, stageOrdinal: 2 } },
  { gateEvidence: { ...input().gateEvidence, checks: [comparison] } },
  { coveringTestRuns: [{ ...input().coveringTestRuns[0], stageId: 404 }] },
  { coveringTestRuns: [{ ...input().coveringTestRuns[0], verifiedSha: "bad" }] },
  { postMergeGates: { ...input().postMergeGates, head: "bad" } },
  { postMergeGates: { ...input().postMergeGates, result: { setupOk: true, comparison: [] } } },
  {
    postMergeGates: {
      ...input().postMergeGates,
      result: { setupOk: true, timedOut: false, comparison: [], workers: { test: false } },
    },
  },
])("invalid local evidence is rejected", (value) => rejects(() => e.encodeTransferEvidence(value, stages)));

test("portable references must exist in the supplied stage mapping and remain strict ordinals", () => {
  const value = e.encodeTransferEvidence(input(), stages);
  for (const stageOrdinal of [0, -1, 0.5, "2", 3, null]) {
    rejects(() =>
      e.parseTransferEvidence({ ...value, gateEvidence: { ...value.gateEvidence, stageOrdinal } }, portable),
    );
    rejects(() =>
      e.parseTransferEvidence(
        { coveringTestRuns: [{ ...value.coveringTestRuns?.[0], stageOrdinal }] },
        portable,
      ),
    );
  }
  rejects(() => e.parseTransferEvidence(value, [{ ordinal: 1 }]));
  rejects(() => e.encodeTransferEvidence(input(), [{ id: 31 }, { id: 31 }]));
  for (const extra of [
    { baseline: {} },
    { baselineCached: true },
    { postMergeGates: { ...value.postMergeGates, unknown: true } },
  ])
    rejects(() => e.parseTransferEvidence({ ...value, ...extra }, portable));
});
