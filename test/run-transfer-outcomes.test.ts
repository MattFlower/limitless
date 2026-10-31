import { expect, test } from "bun:test";
import { ClaimLostError } from "../src/integrations/claim-errors.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import * as o from "../src/pipeline/run-transfer-outcomes.ts";
import { LaterReviewSchema, ReviewSchema } from "../src/pipeline/schemas.ts";
import { fixture, head, rejects, sha } from "./run-transfer-support.ts";

const stages = fixture().stages,
  portable = [{ ordinal: 1 }, { ordinal: 2 }];
const criterion = {
  id: "H-1",
  status: "blocked",
  evidence: `  stageId 900 ${head}  `,
  publicSummary: "#123",
  requirement: "historical classification",
};
const binding = { sha, check: "test", command: "bun test #900" };
const raw = {
  criteria: [{ ...criterion, gateEvidence: { ...binding, stageId: 31 } }],
  overall: "pass",
  notes: `stageId 31 ${head}`,
};
const wireRaw = { ...raw, criteria: [{ ...criterion, gateEvidence: { ...binding, stageOrdinal: 1 } }] };
const verified = {
  ...raw,
  modelId: "fake/model",
  criteria: [{ ...criterion, status: "met", gateEvidence: { ...binding, stageId: 900 } }],
  modelOutput: raw,
};
const wireVerified = {
  ...verified,
  criteria: [{ ...criterion, status: "met", gateEvidence: { ...binding, stageOrdinal: 2 } }],
  modelOutput: wireRaw,
};
const roundTrip = (value: unknown) =>
  o.parseTransferOutcomes(
    JSON.parse(new TextDecoder().decode(encodeTransferJson(o.encodeTransferOutcomes(value, stages)))),
    portable,
  );

test("private generation state and raw verifier output survive independently of substitutions", () => {
  const value = roundTrip({
    holdoutStatus: "generating",
    holdoutModelId: "fake/holdout",
    holdoutSameVendor: false,
    lastVerify: verified,
    pendingVerify: {
      round: 2,
      attempt: 1,
      sha,
      modelOutput: raw,
      modelId: "fake/model",
      browserContext: "unavailable",
    },
    verifyResults: [{ ...verified, round: 2, attempt: 1, sha, browserContext: "available" }],
    lastVerifiedEvidence: { lastVerify: verified },
  });
  expect<unknown>(value.holdoutStatus).toBe("generating");
  expect<unknown>(value.holdoutModelId).toBe("fake/holdout");
  expect<unknown>(value.holdoutSameVendor).toBe(false);
  expect<unknown>(Object.hasOwn(value, "holdout")).toBe(false);
  expect<unknown>(value.lastVerify).toEqual(wireVerified);
  expect<unknown>(value.pendingVerify?.modelOutput).toEqual(wireRaw);
  expect<unknown>(value.verifyResults?.[0]).toEqual({
    ...wireVerified,
    round: 2,
    attempt: 1,
    sha,
    browserContext: "available",
  });
  expect<unknown>(value.verifyResults?.[0]?.modelOutput).toEqual(wireRaw);
  expect<unknown>(value.lastVerifiedEvidence?.lastVerify).toEqual(wireVerified);
  expect<unknown>(new Set(o.outcomesCommitDependencies(value))).toEqual(new Set([sha]));
});

test("stored model bodies retain optional absence, whitespace, catches and unclamped confidence", () => {
  const input = {
    triage: {
      title: "Task",
      task_class: "bugfix",
      complexity: "small",
      risk: "low",
      ambiguity: "low",
      blocking_questions: [],
      summary: "Recorded",
      suggested_profile: "quick",
    },
    specAuthorVendor: "fake",
    spec: {
      summary: " s ",
      assumptions: [],
      requirements: [],
      acceptance_criteria: [{ id: "AC-1", criterion: "test", how_to_verify: "inspect" }],
      out_of_scope: [],
      blocking_questions: [],
    },
    holdout: {
      scenarios: [
        { id: "H-1", description: " private ", steps: " run ", expected: " result ", edge_case: false },
      ],
    },
    lastVerify: {
      modelId: "fake/model",
      criteria: [{ ...criterion, status: "unmet" }],
      overall: "pass",
      notes: "historical verdict",
    },
    lastReview: {
      modelId: "fake/review",
      verdict: "request_changes",
      summary: "",
      findings: [{ severity: "major", file: "a.ts", line: 0, confidence: 1.5 }],
      panel: { candidates: [], verdicts: [], refuted: [], capped: [] },
    },
  };
  expect<unknown>(encodeTransferJson(roundTrip(input))).toEqual(encodeTransferJson(input));
  expect<unknown>(roundTrip({ spec: null, lastVerify: null })).toEqual({ spec: null, lastVerify: null });
  expect<unknown>(roundTrip({})).toEqual({});
});

test("legacy verifier criteria survive every outcome path without adding public summaries", () => {
  const legacy = { id: "H-1", status: "blocked", evidence: `  stageId 900 ${head}  ` };
  const model = {
    criteria: [legacy, { ...legacy, gateEvidence: { ...binding, stageId: 31 } }],
    overall: "pass",
    notes: `stageId 31 ${head}`,
  };
  const expectedModel = {
    ...model,
    criteria: [legacy, { ...legacy, gateEvidence: { ...binding, stageOrdinal: 1 } }],
  };
  const outcome = {
    ...model,
    criteria: [{ ...legacy, status: "met", gateEvidence: { ...binding, stageId: 900 } }],
    modelOutput: model,
    modelId: "fake/model",
  };
  const expectedOutcome = {
    ...outcome,
    criteria: [{ ...legacy, status: "met", gateEvidence: { ...binding, stageOrdinal: 2 } }],
    modelOutput: expectedModel,
  };
  const pending = { round: 1, attempt: 0, sha, modelId: "fake/model", modelOutput: model };
  const input = {
    lastVerify: outcome,
    pendingVerify: pending,
    verifyResults: [{ ...outcome, round: 1 }],
    lastVerifiedEvidence: { lastVerify: outcome },
  };
  const expected = {
    lastVerify: expectedOutcome,
    pendingVerify: { ...pending, modelOutput: expectedModel },
    verifyResults: [{ ...expectedOutcome, round: 1 }],
    lastVerifiedEvidence: { lastVerify: expectedOutcome },
  };
  const value = roundTrip(input);
  expect<unknown>(encodeTransferJson(value)).toEqual(encodeTransferJson(expected));
  for (const verify of [value.lastVerify, value.verifyResults?.[0], value.lastVerifiedEvidence?.lastVerify]) {
    expect<unknown>(Object.hasOwn(verify?.criteria[0] ?? {}, "publicSummary")).toBe(false);
    expect<unknown>(Object.hasOwn(verify?.modelOutput?.criteria[0] ?? {}, "publicSummary")).toBe(false);
  }
  expect<unknown>(Object.hasOwn(value.pendingVerify?.modelOutput.criteria[0] ?? {}, "publicSummary")).toBe(
    false,
  );
  expect<unknown>(o.parseTransferOutcomes(jsonValue(value), portable)).toEqual(expected);
  expect<unknown>(new Set(o.outcomesCommitDependencies(value))).toEqual(new Set([sha]));
  for (const publicSummary of [null, 1, [], {}])
    rejects(() => roundTrip({ lastVerify: { ...outcome, criteria: [{ ...legacy, publicSummary }] } }));
});

function jsonValue(value: unknown) {
  return JSON.parse(new TextDecoder().decode(encodeTransferJson(value)));
}

test("stored verifier fields validate structure without production evidence minimums", () => {
  for (const evidence of ["", " "]) {
    const input = { lastVerify: { ...raw, criteria: [{ ...criterion, evidence }], modelId: "fake/model" } };
    expect<unknown>(encodeTransferJson(roundTrip(input))).toEqual(encodeTransferJson(input));
  }
  for (const fields of [
    { evidence: null },
    { status: "approved" },
    { covering_tests: [{ file: "a.ts", name: 1 }] },
    { blockedReason: "other" },
    { requirement: {} },
    { requirementCitation: 1 },
    { extra: true },
  ])
    rejects(() =>
      roundTrip({ lastVerify: { ...raw, criteria: [{ ...criterion, ...fields }], modelId: "fake/model" } }),
    );
});

test.each(["test", ""])(
  "stored review summary %j remains history across current and saved reviews",
  (summary) => {
    const review = { verdict: "approve", summary, findings: [], modelId: "fake/review" };
    const input = { lastReview: review, lastVerifiedEvidence: { lastReview: review } };
    expect<unknown>(encodeTransferJson(roundTrip(input))).toEqual(encodeTransferJson(input));
    expect<unknown>(ReviewSchema.safeParse(review).success).toBe(false);
    expect<unknown>(LaterReviewSchema.safeParse(review).success).toBe(false);
  },
);

test("historical later-round and panel reviews preserve findings, scopes and saved evidence", () => {
  const finding = {
    severity: "minor",
    file: "a.ts",
    line: 7,
    label: "unaddressed",
    prior: "P2",
    id: "P3",
    agreement: 2,
    verification: {
      verdict: "PLAUSIBLE",
      evidence: " a.ts:7 ",
      trigger: " input ",
      severity: "low",
      category: "correctness",
    },
    duplicates: [{ finder: 1, line: 7, title: "title", detail: "detail", suggestion: "fix" }],
  };
  const later = {
    verdict: "approve",
    summary: "Fixes checked; clear.",
    findings: [],
    modelId: "fake/review",
  };
  const history = [
    {
      round: 2,
      sha,
      blocking: [finding],
      followUps: [],
      panelReview: 2,
      scope: { kind: "fix", range: `${sha}..${head}` },
    },
    {
      round: 1,
      sha: head,
      blocking: [],
      followUps: [finding],
      scope: { kind: "full", range: `${head}...${sha}` },
    },
  ];
  const input = {
    lastReview: later,
    reviewFollowUps: [finding],
    reviewHistory: history,
    lastAudit: [{ rule: "audit", severity: "warn", detail: "recorded" }],
    lastVerifiedEvidence: {
      lastReview: {
        ...later,
        mode: "panel",
        findings: [finding],
        checklist: [{ item: "test", applies: "yes", checked: "done", finding: null }],
      },
      reviewHistory: history,
    },
  };
  expect<unknown>(roundTrip(input)).toEqual(input);
  expect<unknown>(o.outcomesCommitDependencies(roundTrip(input))).toEqual([
    sha,
    sha,
    head,
    head,
    head,
    sha,
    sha,
    sha,
    head,
    head,
    head,
    sha,
  ]);
  for (const range of ["base..head", `${sha}.${head}`, `${sha}....${head}`, `${sha}..${head}\n`])
    rejects(() => roundTrip({ reviewHistory: [{ ...history[0], scope: { kind: "fix", range } }] }));
  rejects(() => roundTrip({ reviewHistory: [{ ...history[0], extra: true }] }));
  rejects(() => roundTrip({ reviewFollowUps: [{ ...finding, label: "invalid" }] }));
  expect<unknown>(roundTrip({ lastReview: { ...later, summary: "too short" } })).toEqual({
    lastReview: { ...later, summary: "too short" },
  });
});

test("commit dependencies follow every typed binding and nested gate provenance, never prose", () => {
  const oid = (n: number) => n.toString(16).padStart(40, "0");
  const verify = (n: number) => ({
    ...verified,
    sha: oid(n),
    criteria: [{ ...criterion, gateEvidence: { ...binding, sha: oid(n + 1), stageId: 900 } }],
    modelOutput: {
      ...raw,
      criteria: [{ ...criterion, gateEvidence: { ...binding, sha: oid(n + 2), stageId: 31 } }],
    },
  });
  const gate = {
    name: "test",
    verdict: "pass",
    blocking: false,
    result: {
      name: "test",
      command: head,
      ok: true,
      exitCode: 0,
      output: head,
      durationMs: 0,
      executionProvenance: { sha: oid(13) },
    },
  };
  const value = roundTrip({
    lastVerify: verify(1),
    verifyResults: [{ ...verify(4), round: 1 }],
    pendingVerify: {
      round: 1,
      attempt: 0,
      sha: oid(7),
      modelId: "fake/model",
      modelOutput: verify(4).modelOutput,
    },
    lastVerifiedEvidence: {
      lastVerify: verify(8),
      lastGates: [gate],
      reviewHistory: [
        {
          round: 1,
          sha: oid(11),
          blocking: [],
          followUps: [],
          scope: { kind: "resolution", range: `${oid(12)}..${sha}` },
        },
      ],
    },
  });
  expect<unknown>(new Set(o.outcomesCommitDependencies(value))).toEqual(
    new Set([sha, ...Array.from({ length: 13 }, (_, i) => oid(i + 1))]),
  );
});

test("stage remapping rejects unknown, duplicate, zero and malformed bindings at every path", () => {
  const bad = { ...raw, criteria: [{ ...criterion, gateEvidence: { ...binding, stageId: 404 } }] };
  for (const value of [
    { lastVerify: { ...bad, modelId: "fake/model" } },
    { pendingVerify: { round: 1, attempt: 0, sha, modelId: "fake", modelOutput: bad } },
    { verifyResults: [{ ...bad, round: 1, modelId: "fake" }] },
    { verifyResults: [{ ...verified, round: 1, modelOutput: bad }] },
    { lastVerifiedEvidence: { lastVerify: { ...verified, modelOutput: bad } } },
  ])
    rejects(() => roundTrip(value));
  rejects(() => o.encodeTransferOutcomes({}, [{ id: 31 }, { id: 31 }]));
  for (const stageOrdinal of [0, 3, -1, 1.5, "1", null])
    rejects(() =>
      o.parseTransferOutcomes(
        {
          lastVerify: {
            ...wireRaw,
            modelId: "fake/model",
            criteria: [{ ...criterion, gateEvidence: { ...binding, stageOrdinal } }],
          },
        },
        portable,
      ),
    );
  rejects(() =>
    o.parseTransferOutcomes({ lastVerifiedEvidence: { lastVerify: wireVerified } }, [{ ordinal: 1 }]),
  );
  for (const gateEvidence of [
    { ...binding, stageId: 0 },
    { ...binding, stageId: 31, extra: true },
    { ...binding, stageId: 31, sha: "bad" },
  ])
    rejects(() =>
      roundTrip({
        lastVerify: { ...raw, modelId: "fake/model", criteria: [{ ...criterion, gateEvidence }] },
      }),
    );
});

test("factory wrappers and JSON preflight fail closed while claim-control retains identity", () => {
  for (const value of [
    { extra: true },
    { lastVerifiedEvidence: { pendingVerify: {} } },
    { lastVerify: { ...verified, extra: true } },
    { pendingVerify: { round: 1, attempt: 0, sha, modelId: "fake", modelOutput: raw, extra: true } },
    { lastAudit: [{ rule: "x" }] },
    { holdoutStatus: "ready" },
    { spec: undefined },
    { lastVerify: raw },
    { lastReview: { verdict: "approve", summary: "Fixes checked; clear.", findings: [] } },
  ])
    rejects(() => roundTrip(value));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  rejects(() => roundTrip(cyclic));
  const control = new ClaimLostError();
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw control;
      },
    },
  );
  expect<unknown>(() => o.encodeTransferOutcomes(hostile, stages)).toThrow(control);
});
