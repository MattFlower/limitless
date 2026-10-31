import { expect, test } from "bun:test";
import type { Phase } from "../src/pipeline/context.ts";
import { parseTransferControl, type TransferControl } from "../src/pipeline/run-transfer-control.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { decodeRunTransferRows, encodeRunTransferRows } from "../src/pipeline/run-transfer-rows.ts";
import { fixture, head, repo, sha } from "./run-transfer-support.ts";

const jsonRoundTrip = (value: unknown): unknown =>
  JSON.parse(new TextDecoder().decode(encodeTransferJson(value)));
function minimal(): TransferControl {
  return {
    phase: "loop",
    answers: [],
    round: 0,
    feedback: null,
    toolCommands: [],
    roundsOnImplementer: 0,
    triedImplementers: [],
  };
}
function populated(): TransferControl {
  return {
    ...minimal(),
    phase: "done",
    flow: "build",
    parked: false,
    answers: ["second", "first", "second"],
    round: 9,
    toolCommands: ["test", "lint", "test"],
    implementer: {
      policyRevision: "retired-policy",
      targetId: "missing-target",
      effort: null,
      modelId: "retired/model",
      tier: 4,
      vendor: "historical-vendor",
    },
    roundsOnImplementer: 8,
    triedImplementers: [
      "legacy",
      { modelId: "retired/model", effort: null },
      "legacy",
      { modelId: "other", effort: "xhigh" },
    ],
    environmentRetryRound: 7,
    conflictRound: 6,
    gateTimeoutReruns: 5,
    implementationReadyRound: 9,
    implementedRound: 8,
    workerCommitRound: 7,
    implementerReport: "interrupted",
    implementerIssue: null,
    githubWait: { since: 1, nextAttemptAt: Number.MAX_SAFE_INTEGER, reason: "recorded wait" },
    verification: { baseSha: sha, headSha: head, initialComplete: false },
    reviewBaseSha: head,
    reviewResolution: { sha, feedback: "unresolved" },
    conflictFiles: ["z.ts", "a.ts", "z.ts"],
    publishedSha: sha,
    publishingSha: head,
    deliveryComplete: false,
    verdictCommentPosted: false,
    verdictCommentPending: true,
    pendingRebaseSha: head,
    preRebaseHead: sha,
    deliveryMerges: [
      { runId: "logical-z", reviewedSha: sha, sha: head, head: sha, base: head },
      { runId: "logical-a", reviewedSha: head, sha, head, base: sha },
    ],
    postMergeRejection: { reason: "rejected", sha, base: head, head: sha, round: 9 },
    lastVerifiedSha: head,
    reviewedSha: sha,
    rebaseNote: "kept base",
    terminalReason: "cancelled after error",
    needsHumanReason: "needs manual review",
  };
}
function changed(path: string, value: unknown): unknown {
  const input = populated();
  const keys = path.split(".");
  let parent: object = input;
  for (const key of keys.slice(0, -1)) {
    const next: unknown = Reflect.get(parent, key);
    if (!next || typeof next !== "object") throw new Error("Missing fixture object");
    parent = next;
  }
  Reflect.set(parent, keys.at(-1) ?? path, value);
  return input;
}
function invalid(value: unknown) {
  expect(() => parseTransferControl(value)).toThrow(
    expect.objectContaining({
      name: "RunTransferError",
      code: "invalid",
      message: "Run transfer data is invalid",
    }),
  );
}

test("budgets, historical selections and interrupted markers survive validation and JSON", () => {
  const result = parseTransferControl(jsonRoundTrip(parseTransferControl(populated())));
  expect(result).toMatchObject({
    round: 9,
    roundsOnImplementer: 8,
    environmentRetryRound: 7,
    conflictRound: 6,
    gateTimeoutReruns: 5,
    implementationReadyRound: 9,
    implementedRound: 8,
    workerCommitRound: 7,
    implementer: {
      policyRevision: "retired-policy",
      targetId: "missing-target",
      effort: null,
      modelId: "retired/model",
      tier: 4,
      vendor: "historical-vendor",
    },
    implementerReport: "interrupted",
    implementerIssue: null,
  });
  expect(result.triedImplementers).toEqual([
    "legacy",
    { modelId: "retired/model", effort: null },
    "legacy",
    { modelId: "other", effort: "xhigh" },
  ]);
  expect(result.answers).toEqual(["second", "first", "second"]);
  expect(result.toolCommands).toEqual(["test", "lint", "test"]);
  expect(result.conflictFiles).toEqual(["z.ts", "a.ts", "z.ts"]);
  expect(result).toMatchObject({
    verification: { baseSha: sha, headSha: head, initialComplete: false },
    reviewBaseSha: head,
    reviewResolution: { sha, feedback: "unresolved" },
    pendingRebaseSha: head,
    preRebaseHead: sha,
    lastVerifiedSha: head,
    reviewedSha: sha,
  });
});

test("uncertain publication and rejected attempts coexist with ordered completed merges", () => {
  for (const omitFlags of [false, true]) {
    const input = populated();
    if (omitFlags) {
      delete input.deliveryComplete;
      delete input.verdictCommentPosted;
    }
    const result = parseTransferControl(jsonRoundTrip(parseTransferControl(input)));
    expect(result.publishedSha).toBe(sha);
    expect(result.publishingSha).toBe(head);
    expect(result.verdictCommentPending).toBe(true);
    for (const key of ["deliveryComplete", "verdictCommentPosted"] as const) {
      expect(Object.hasOwn(result, key)).toBe(!omitFlags);
      expect(result[key]).toBe(omitFlags ? undefined : false);
    }
    expect(result.deliveryMerges).toEqual([
      { runId: "logical-z", reviewedSha: sha, sha: head, head: sha, base: head },
      { runId: "logical-a", reviewedSha: head, sha, head, base: sha },
    ]);
    expect(result.postMergeRejection).toEqual({ reason: "rejected", sha, base: head, head: sha, round: 9 });
  }
});

const counters = [
  "round",
  "roundsOnImplementer",
  "environmentRetryRound",
  "conflictRound",
  "gateTimeoutReruns",
  "implementationReadyRound",
  "implementedRound",
  "workerCommitRound",
  "implementer.tier",
  "postMergeRejection.round",
  "githubWait.since",
  "githubWait.nextAttemptAt",
];
test.each(counters)("%s uses safe nonnegative counters without coercion", (path) => {
  for (const value of [-0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "2", null])
    invalid(changed(path, value));
  for (const value of [0, Number.MAX_SAFE_INTEGER])
    expect(parseTransferControl(changed(path, value))).toHaveProperty(path, value);
});

const commits = [
  "verification.baseSha",
  "verification.headSha",
  "reviewBaseSha",
  "reviewResolution.sha",
  "publishedSha",
  "publishingSha",
  "pendingRebaseSha",
  "preRebaseHead",
  "lastVerifiedSha",
  "reviewedSha",
  "deliveryMerges.0.reviewedSha",
  "deliveryMerges.0.sha",
  "deliveryMerges.0.head",
  "deliveryMerges.0.base",
  "postMergeRejection.sha",
  "postMergeRejection.base",
  "postMergeRejection.head",
];
test.each(commits)("%s preserves valid OIDs and rejects malformed references", (path) => {
  for (const value of ["private-input", "a".repeat(39), "g".repeat(40), `${sha}\n`, null, 1])
    invalid(changed(path, value));
  for (const value of [sha, head])
    expect(parseTransferControl(changed(path, value))).toHaveProperty(path, value);
});

test.each([
  "unclassified",
  "implementer.unclassified",
  "triedImplementers.1.unclassified",
  "githubWait.unclassified",
  "verification.unclassified",
  "reviewResolution.unclassified",
  "deliveryMerges.0.unclassified",
  "postMergeRejection.unclassified",
  "worktreePath",
  "worktreeAliases",
  "agentJob",
  "gateExecution",
  "postMergeGates",
  "acceptance",
  "reviewMode",
  "lastReview",
  "leaseValid",
  "githubWait.leaseValid",
  "githubWait.deadline",
])("unknown or excluded control member %s is rejected", (path) => invalid(changed(path, "private-input")));

test("required fields, enums, nested shapes and disallowed nulls are strict", () => {
  for (const key of [
    "phase",
    "answers",
    "round",
    "feedback",
    "toolCommands",
    "roundsOnImplementer",
    "triedImplementers",
  ]) {
    const input = minimal();
    Reflect.deleteProperty(input, key);
    invalid(input);
  }
  for (const [path, value] of [
    ["phase", "queued"],
    ["flow", "future"],
    ["parked", null],
    ["answers", [null]],
    ["toolCommands", "test"],
    ["feedback", false],
    ["githubWait", { since: 1, reason: "missing timestamp" }],
    ["implementer", { modelId: "m", tier: 1 }],
    ["implementer.effort", "default"],
    ["triedImplementers", [{ modelId: "m" }]],
    ["verification", { baseSha: sha }],
    ["reviewResolution", null],
    ["deliveryMerges", null],
    ["postMergeRejection", null],
  ] as const)
    invalid(changed(path, value));
  invalid({ ...minimal(), parked: undefined });
});

test("optional absence, explicit nulls and historical terminal markers survive", () => {
  expect(parseTransferControl(jsonRoundTrip(parseTransferControl(minimal())))).toEqual({
    phase: "loop",
    answers: [],
    round: 0,
    feedback: null,
    toolCommands: [],
    roundsOnImplementer: 0,
    triedImplementers: [],
  });
  const result = parseTransferControl(jsonRoundTrip(parseTransferControl(populated())));
  expect(result).toMatchObject({
    phase: "done",
    parked: false,
    feedback: null,
    implementerIssue: null,
    implementer: { effort: null },
    rebaseNote: "kept base",
    terminalReason: "cancelled after error",
    needsHumanReason: "needs manual review",
  });
  expect(
    parseTransferControl({
      ...minimal(),
      reviewResolution: {},
      implementer: { modelId: "m", tier: 0, vendor: "v" },
    }),
  ).toMatchObject({ reviewResolution: {}, implementer: { modelId: "m", tier: 0, vendor: "v" } });
});

test.each(["cancelled", "needs_human"] as const)("row history retains %s and invocation errors", (status) => {
  const input = fixture();
  input.run.status = status;
  input.run.error = "cancelled after error; needs manual review";
  input.invocations = input.invocations.map((row) => ({
    ...row,
    status: "error",
    error: "interrupted invocation",
  }));
  const result = decodeRunTransferRows(jsonRoundTrip(encodeRunTransferRows(input, repo)), repo);
  expect(result.run.status).toBe(status);
  expect(result.run.error).toBe("cancelled after error; needs manual review");
  expect(result.invocations.map(({ status, error }) => ({ status, error }))).toEqual([
    { status: "error", error: "interrupted invocation" },
    { status: "error", error: "interrupted invocation" },
  ]);
});

test.each(["prepare", "triage", "clarify", "spec", "loop", "deliver", "accept", "done"] satisfies Phase[])(
  "phase %s preserves historical and far-future scheduling timestamps",
  (phase) => {
    const result = parseTransferControl(jsonRoundTrip(parseTransferControl({ ...populated(), phase })));
    expect(result.phase).toBe(phase);
    expect(result.githubWait).toEqual({
      since: 1,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      reason: "recorded wait",
    });
  },
);
