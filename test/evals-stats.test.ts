import { expect, test } from "bun:test";
import type { EvalRun, EvalTrial } from "../src/core/types.ts";
import { formatEvalReport } from "../src/evals/format.ts";
import { pairedBootstrap, statsOptions, summarize, wilson } from "../src/evals/stats.ts";

export const run: EvalRun = {
  id: "eval",
  role: "triage",
  models: ["a", "b"],
  k: 2,
  maxUsd: 1,
  status: "completed",
  createdAt: 1,
  finishedAt: 2,
  error: null,
};
export function trial(modelId: string, caseId: string, index: number, pass: boolean): EvalTrial {
  return {
    effort: "default",
    evalRunId: run.id,
    modelId,
    caseId,
    trial: index,
    status: "ok",
    output: null,
    pass,
    score: Number(pass),
    cacheKey: "key",
    harness: "fake",
    details: {},
    costUsd: 0.1,
    costEquivUsd: 0.2,
    tokensIn: 1,
    tokensOut: 2,
    durationMs: index ? 30 : 10,
    createdAt: 1,
  };
}
test("Wilson 95% hand-computed bounds and empty/invalid counts", () => {
  for (const [passed, low, high] of [
    [0, 0, 0.277533],
    [5, 0.236593, 0.763407],
    [10, 0.722467, 1],
  ]) {
    const ci = wilson(passed ?? 0, 10);
    expect(ci?.[0]).toBeCloseTo(low ?? 0, 6);
    expect(ci?.[1]).toBeCloseTo(high ?? 0, 6);
  }
  expect(wilson(0, 0)).toBeNull();
  expect(() => wilson(2, 1)).toThrow();
});
test("paired bootstrap is seeded, has strict margin, and handles missing observations", () => {
  const pairs = [0, 1, -1, 0.5, -0.5];
  expect(pairedBootstrap(pairs)).toEqual(pairedBootstrap(pairs));
  expect(pairedBootstrap([0, 0])).toMatchObject({ meanDifference: 0, lowerBound: 0, nonInferior: true });
  expect(pairedBootstrap([-0.1], { delta: 0.1 })).toMatchObject({ lowerBound: -0.1, nonInferior: false });
  expect(pairedBootstrap([-0.1], { delta: 0.11 }).nonInferior).toBe(true);
  expect(pairedBootstrap([])).toMatchObject({
    pairedCases: 0,
    meanDifference: null,
    lowerBound: null,
    nonInferior: null,
  });
  for (const opts of [{ delta: NaN }, { delta: -1 }, { seed: -1 }, { seed: 1.5 }, { resamples: 0 }])
    expect(() => statsOptions(opts)).toThrow();
});
test("reports use evaluated trials and complete paired cases; flips and latency disclose denominators", () => {
  const rows = [
    trial("a", "one", 0, true),
    trial("a", "one", 1, false),
    trial("b", "one", 0, true),
    trial("b", "one", 1, true),
    trial("a", "partial", 0, true),
  ];
  rows.push({ ...trial("b", "partial", 0, false), status: "skipped", pass: null, score: null });
  const [a, b] = summarize(run, rows);
  expect(a).toMatchObject({
    cases: 2,
    evaluatedTrials: 3,
    passes: 2,
    flipRate: 1,
    flipDenominator: 1,
    p50LatencyMs: 10,
    comparison: { bestModel: "b", pairedCases: 1, meanDifference: -0.5, nonInferior: false },
  });
  expect(b).toMatchObject({ skipped: 1, flipRate: 0, p50LatencyMs: 20 });
  expect(summarize({ ...run, k: 1 }, [trial("a", "one", 0, true)])[0]?.flipRate).toBeNull();
  const empty = summarize(run, [])[0];
  expect(empty).toMatchObject({
    passRate: null,
    ci: null,
    meanScore: null,
    riskUnderCallRate: null,
    p50LatencyMs: null,
    comparison: { bestModel: null, pairedCases: 0 },
  });
  expect(
    summarize(run, [trial("a", "one", 0, true), trial("b", "two", 0, true)])[0]?.comparison.pairedCases,
  ).toBe(0);
});

test("review pools defects across repetitions, preserves empty denominators and excludes errors from prediction metrics", async () => {
  const { gradeReview } = await import("../src/evals/graders/review.ts");
  const { reviewCase, reviewOutput } = await import("./evals-reading-support.ts");
  const one = gradeReview(reviewCase, reviewOutput());
  const many = gradeReview(
    {
      ...reviewCase,
      defects: [
        ...reviewCase.defects,
        ...[1, 2, 3].map((i) => ({
          ...reviewCase.defects[0],
          file: `miss${i}`,
          lines: [1, 2] as [number, number],
          severity: "major" as const,
          category: "correctness",
          summary: "miss",
          required: true,
          foundBy: "test",
        })),
      ],
    },
    reviewOutput(),
  );
  const clean = gradeReview(
    { ...reviewCase, kind: "clean", defects: [] },
    { ...reviewOutput(), verdict: "approve", findings: [] },
  );
  const rows: EvalTrial[] = [one, many, clean, one, many, clean].map((grade, i) => ({
    ...trial("a", String(i % 3), Math.floor(i / 3), grade.pass === true),
    details: { grade },
  }));
  rows.push({ ...trial("a", "error", 0, false), status: "error", details: {} });
  const summary = summarize({ ...run, role: "review" }, rows)[0];
  expect(summary).toMatchObject({
    predictionTrials: 6,
    scheduledTrials: 7,
    errors: 1,
    review: {
      defectRecall: { numerator: 4, denominator: 10, rate: 0.4 },
      falseBlock: { numerator: 0, denominator: 2, rate: 0 },
      verdictAccuracy: { numerator: 6, denominator: 6, rate: 1 },
    },
  });
  expect(summary?.review?.defectRecall.ci?.[0]).toBeCloseTo(0.16818, 6);
  expect(summary?.review?.defectRecall.ci?.[1]).toBeCloseTo(0.687326, 6);
  expect(
    summarize({ ...run, role: "review" }, [rows[0] as EvalTrial])[0]?.review?.falseBlock.rate,
  ).toBeNull();
  expect(summarize({ ...run, role: "review" }, [rows[2] as EvalTrial])[0]?.review?.defectRecall).toEqual({
    numerator: 0,
    denominator: 0,
    rate: null,
    ci: null,
  });
});

test("verify reports pooled confusion counts, accuracy and null rates without labels", async () => {
  const { gradeVerify } = await import("../src/evals/graders/verify.ts");
  const { loadRoleCases, VerifyCaseFileSchema } = await import("../src/evals/cases.ts");
  const item = VerifyCaseFileSchema.parse(
    loadRoleCases("verify", new URL("./data/evals-verify.json", import.meta.url).pathname),
  ).cases[2];
  if (!item) throw new Error("fixture");
  const grade = gradeVerify(item, {
    overall: "pass",
    notes: "",
    criteria: [
      { id: "AC-1", status: "met", evidence: "false accept", publicSummary: "" },
      { id: "H-1", status: "unclear", evidence: "false reject", publicSummary: "" },
    ],
  });
  const rows: EvalTrial[] = [0, 1].map((i) => ({ ...trial("a", "mixed", i, false), details: { grade } }));
  rows.push({ ...trial("a", "error", 0, false), status: "error", details: {} });
  expect(summarize({ ...run, role: "verify" }, rows)[0]).toMatchObject({
    predictionTrials: 2,
    verify: {
      falseAccept: { numerator: 2, denominator: 2, rate: 1 },
      falseReject: { numerator: 2, denominator: 2, rate: 1 },
      criterionAccuracy: { numerator: 0, denominator: 4, rate: 0 },
    },
  });
  expect(summarize({ ...run, role: "verify" }, [])[0]?.verify).toEqual({
    falseAccept: { numerator: 0, denominator: 0, rate: null },
    falseReject: { numerator: 0, denominator: 0, rate: null },
    criterionAccuracy: { numerator: 0, denominator: 0, rate: null },
  });
});

test("summaries and paired comparisons separate efforts of the same base model", () => {
  const trials = [
    { ...trial("a", "case", 0, false), effort: "low" as const },
    { ...trial("a", "case", 0, true), effort: "high" as const },
    { ...trial("a", "case", 0, true), effort: "none" as const },
    { ...trial("a", "case", 0, false), effort: null },
  ];
  const rows = summarize({ ...run, models: ["a@low", "a@high", "a@none", "a"], k: 1 }, trials);
  expect(rows.map((s) => [s.modelId, s.passRate])).toEqual([
    ["a@low", 0],
    ["a@high", 1],
    ["a@none", 1],
    ["a (unknown effort)", 0],
  ]);
  expect(rows.every((s) => s.evaluatedTrials === 1 && s.comparison.pairedCases === 1)).toBe(true);
  expect(rows.find((s) => s.modelId === "a (unknown effort)")?.effort).toBeNull();
});

test("legacy unknown effort and backend-default rows are summarized separately", () => {
  const trials = [
    trial("a", "case", 0, true),
    { ...trial("a", "other", 0, false), effort: null },
    { ...trial("a", "third", 0, false), effort: null },
  ];
  const rows = summarize({ ...run, models: ["a"], k: 1 }, trials);
  expect(rows.map((s) => [s.modelId, s.effort, s.evaluatedTrials, s.passRate])).toEqual([
    ["a", "default", 1, 1],
    ["a (unknown effort)", null, 2, 0],
  ]);
});

test("implement reports complexity, failure reasons, executed costs and median time with empty groups", () => {
  const impl = { ...run, role: "implement" as const };
  const rows = [trial("a", "one", 0, true), trial("a", "one", 1, false)];
  for (const row of rows) row.details.complexity = "small";
  const failed = rows[1];
  if (!failed) throw new Error("fixture");
  failed.status = "error";
  failed.details.grade = {
    pass: false,
    score: 0,
    fields: {},
    riskUnderCall: null,
    implement: {
      reason: "timeout",
      commit: null,
      gates: [],
      auditBlocks: [],
      auditWarnings: [],
      hidden: null,
    },
  };
  rows.push({
    ...trial("a", "cached", 0, true),
    costUsd: 0,
    costEquivUsd: 0,
    durationMs: 0,
    details: {
      complexity: "trivial",
      cache: {
        evalRunId: "source",
        caseId: "one",
        costUsd: 0.1,
        costEquivUsd: 0.2,
        tokensIn: 1,
        tokensOut: 2,
        durationMs: 10,
      },
    },
  });
  rows.push(
    { ...trial("a", "skipped", 0, false), status: "skipped", pass: null },
    { ...trial("a", "queued", 0, false), status: "queued", pass: null },
  );
  const summaries = summarize(impl, rows);
  const result = summaries[0];
  expect(result).toMatchObject({
    passes: 2,
    evaluatedTrials: 3,
    ci: wilson(2, 3),
    p50LatencyMs: 20,
    implement: {
      executedTrials: 2,
      costPerTrialUsd: 0.1,
      costEquivPerTrialUsd: 0.2,
      failureReasons: { timeout: 1, error: 0, gates: 0, audit: 0, hidden_tests: 0 },
      byComplexity: [
        { complexity: "trivial", passes: 1, evaluatedTrials: 1, ci: wilson(1, 1) },
        { complexity: "small", passes: 1, evaluatedTrials: 2, ci: wilson(1, 2) },
        { complexity: "medium", passes: 0, evaluatedTrials: 0, passRate: null, ci: null },
      ],
    },
  });
  expect(summaries[1]?.implement?.costPerTrialUsd).toBeNull();
  const text = formatEvalReport({ run: impl, trials: rows, summaries });
  for (const fragment of [
    "small pass 50.0%",
    "medium pass n/a",
    "timeout=1",
    "p50 trial 20.000",
    "cost per executed trial",
  ])
    expect(text).toContain(fragment);
});

test("multi-round reports count independent trials, recovery costs, cache evidence and legacy rows", () => {
  const multi = {
    ...run,
    role: "implement" as const,
    k: 1,
    models: ["a"],
    rounds: 3,
    strategy: "effort" as const,
  };
  const rows = [true, true, true, false].map((pass, i) => {
    const t = trial("a", String(i), 0, pass);
    t.details.rounds = (i === 0 ? [true] : [false, pass]).map((p, round) => ({
      round,
      modelId: "a",
      effort: "low",
      status: "ok",
      pass: p,
      reason: p ? null : "hidden_tests",
      costUsd: round ? 2 : 10,
      costEquivUsd: round ? 4 : 20,
      tokensIn: 1,
      tokensOut: 2,
      durationMs: 3,
    }));
    return t;
  });
  const summary = () => summarize(multi, rows)[0]?.implement;
  expect(summary()).toMatchObject({
    passAt1: { rate: 1 / 4 },
    passAtR: { rate: 3 / 4 },
    recovery: {
      numerator: 2,
      denominator: 3,
      rate: 2 / 3,
      ci: wilson(2, 3),
      executedTrials: 3,
      executedRecoveries: 2,
      costPerRecoveryUsd: 3,
      costEquivPerRecoveryUsd: 6,
    },
  });
  const cached = rows[1];
  if (!cached) throw new Error("missing trial");
  cached.details.cache = {
    evalRunId: "old",
    caseId: "1",
    costUsd: 12,
    costEquivUsd: 24,
    tokensIn: 2,
    tokensOut: 4,
    durationMs: 6,
  };
  expect(summary()?.recovery).toMatchObject({
    numerator: 2,
    denominator: 3,
    executedTrials: 2,
    executedRecoveries: 1,
    costPerRecoveryUsd: 4,
  });
  const text = formatEvalReport({ run: multi, trials: rows, summaries: summarize(multi, rows) });
  expect(text).toContain("strategy=effort, rounds=3");
  expect(text).toContain("pass@1 25.0%");
  expect(text).toContain("pass@3 75.0%");
  rows.splice(1);
  expect(summary()?.recovery).toMatchObject({ rate: null, ci: null, costPerRecoveryUsd: null });
  const legacy = rows[0];
  if (!legacy) throw new Error("missing trial");
  delete legacy.details.rounds;
  expect(summary()?.passAt1.rate).toBe(1);
  legacy.pass = false;
  legacy.details.grade = {
    pass: false,
    score: 0,
    fields: {},
    riskUnderCall: null,
    implement: {
      reason: "hidden_tests",
      gates: [],
      auditBlocks: [],
      auditWarnings: [],
      commit: null,
      hidden: null,
    },
  };
  expect(summary()?.recovery).toMatchObject({
    numerator: 0,
    denominator: 1,
    rate: 0,
    costPerRecoveryUsd: null,
  });
});
