import { expect, test } from "bun:test";
import type { EvalRun, EvalTrial } from "../src/core/types.ts";
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
