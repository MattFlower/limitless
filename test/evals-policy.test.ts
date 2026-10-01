import { expect, test } from "bun:test";
import { proposedOverlay, renderEvidence } from "../src/evals/evidence.ts";
import { gradeReview } from "../src/evals/graders/review.ts";
import { EVAL_ROLES, generatePolicy, selectEvidence } from "../src/evals/policy.ts";
import { evalSettings } from "../src/evals/settings.ts";
import { pairedBootstrap, wilson } from "../src/evals/stats.ts";
import { DEFAULT_POLICY, MODELS } from "../src/router/catalog.ts";
import { overlayPolicy, validatePolicy } from "../src/router/policy.ts";
import { parseTarget, recordedTarget } from "../src/router/targets.ts";
import { evalMatrix } from "../ui/lib/evals.ts";
import { evidence, input, local, metered, response, subscription } from "./evals-policy-support.ts";
import { reviewCase, reviewOutput } from "./evals-reading-support.ts";

const first = (data: ReturnType<typeof input>) => {
  const candidate = generatePolicy(data).roles.flatMap((r) => r.candidates)[0];
  if (!candidate) throw new Error("expected candidate");
  return candidate;
};

test("independent latest completed role/model evidence, deterministic ties and explicit IDs", () => {
  const old = evidence("triage", [local, subscription], { id: "old" });
  const newer = evidence("triage", [local], { id: "new", finishedAt: 3000 });
  const tie = evidence("triage", [local], { id: "z", finishedAt: 3000 });
  const created = evidence("triage", [local], { id: "a", finishedAt: 3000, createdAt: 1500 });
  const review = evidence("review", [local]);
  const ignored = (["running", "queued", "failed", "budget_exhausted", "interrupted"] as const).map(
    (status) => evidence("triage", [local], { id: status, status, finishedAt: 9999 }),
  );
  const rows = [old, newer, tie, created, review, ...ignored];
  expect(selectEvidence(rows).map((e) => [e.run.role, e.modelId, e.run.id])).toEqual([
    ["review", local, "review-run"],
    ["triage", subscription, "old"],
    ["triage", local, "a"],
  ]);
  expect(selectEvidence([newer, tie])[0]?.run.id).toBe("z");
  expect(selectEvidence(rows, ["old", "new", "old"]).map((e) => e.run.id)).toEqual(["old", "new"]);
  expect(selectEvidence(rows.reverse()).map((e) => e.run.id)).toEqual(["review-run", "old", "a"]);
  for (const ids of [
    [],
    [""],
    [" "],
    ["missing"],
    ["old", "failed"],
    ["queued"],
    ["running"],
    ["budget_exhausted"],
  ])
    expect(() => selectEvidence(rows, ids)).toThrow();
  expect(() => selectEvidence(rows, ["interrupted"])).toThrow(
    "Eval interrupted is interrupted, not completed",
  );
});

for (const [role, field, bound] of [
  ["triage", "triage_pass_rate", "lower"],
  ["triage", "triage_risk_under_call_rate", "upper"],
  ["review", "review_defect_recall", "lower"],
  ["review", "review_clean_false_block_rate", "upper"],
  ["verify", "verify_false_accept_rate", "upper"],
] as const)
  test(`${field}: inclusive boundary (Wilson lower bound for floors, upper bound for ceilings)`, () => {
    const rows = [evidence(role)];
    // Two error events so the ceiling boundary is a real nonzero rate.
    for (const t of rows[0]?.trials.filter((t) => t.details.grade?.review?.falseBlock !== null).slice(0, 2) ??
      []) {
      const grade = t.details.grade;
      if (!grade) throw new Error("missing grade");
      if (grade.riskUnderCall !== null) grade.riskUnderCall = true;
      if (grade.review) grade.review.falseBlock = true;
      if (grade.verify) grade.verify.falseAccepts = 1;
    }
    const initial = first(input(rows));
    const index =
      field === "triage_risk_under_call_rate" || field === "review_clean_false_block_rate" ? 1 : 0;
    const metric = initial.metrics[index];
    if (!metric?.ci || metric.rate === null) throw new Error("missing interval");
    const threshold = bound === "lower" ? metric.ci[0] : metric.ci[1];
    if (bound === "upper") expect(metric.rate).toBeGreaterThan(0);
    // Every other ceiling is made achievable so only the metric under test decides eligibility.
    const permissive = {
      triage_risk_under_call_rate: 1,
      review_clean_false_block_rate: 1,
      verify_false_accept_rate: 1,
    };
    const settings = evalSettings({ evals: { floors: { ...permissive, [field]: threshold } } });
    expect(first(input(rows, { settings })).eligible).toBe(true);
    settings.floors[field] = threshold + (bound === "lower" ? 0.0001 : -0.0001);
    const rejected = first(input(rows, { settings }));
    expect(rejected.eligible).toBe(false);
    expect(rejected.reasons.join()).toContain(bound === "lower" ? "is below floor" : "exceeds ceiling");
  });

test("review_defect_recall uses blocking recall: under-rated detections and legacy grades don't clear the floor", () => {
  const graded = (severity: "major" | "minor") => {
    const row = evidence("review", [local]);
    for (const t of row.trials) {
      const item = t.caseId < "case-20" ? reviewCase : { ...reviewCase, kind: "clean" as const, defects: [] };
      const output = t.caseId < "case-20" ? reviewOutput(10, severity) : { ...reviewOutput(), findings: [] };
      t.output = output;
      t.details = { grade: gradeReview(item, output) };
    }
    return row;
  };
  const blocking = first(input([graded("major")]));
  expect(blocking.metrics[0]).toMatchObject({ name: "blocking recall", numerator: 20, denominator: 20 });
  expect(blocking.metrics[0]?.reason).toBeNull();
  const underRated = first(input([graded("minor")]));
  expect(underRated.metrics[0]).toMatchObject({ numerator: 0, denominator: 20 });
  expect(underRated.eligible).toBe(false);
  expect(underRated.reasons.join()).toContain("blocking recall lower bound 0.0000 is below floor 0.5");
  expect(underRated.summary.review?.underRated).toMatchObject({ numerator: 20, denominator: 20 });
  // Grades stored before blocking recall counted minor matches; they are not evidence until regraded.
  const legacy = graded("minor");
  for (const t of legacy.trials) {
    const review = t.details.grade?.review;
    if (!review) continue;
    delete review.underRated;
    delete review.blockingFindings;
    delete review.bySeverity;
    review.requiredMatched = review.requiredTotal;
  }
  expect(first(input([legacy])).metrics[0]).toMatchObject({ numerator: 0, denominator: 0 });
  expect(first(input([legacy])).state).toBe("insufficient evidence");
  // A run mixing both grade versions must not hide legacy minor-only matches behind blocking recall.
  const mixed = graded("major");
  for (const t of mixed.trials.slice(0, 10)) {
    const review = t.details.grade?.review;
    if (!review) continue;
    t.output = reviewOutput(10, "minor");
    delete review.underRated;
    delete review.blockingFindings;
    delete review.bySeverity;
  }
  const mixedCandidate = first(input([mixed]));
  expect(mixedCandidate.metrics[0]).toMatchObject({ numerator: 10, denominator: 10 });
  expect(mixedCandidate.state).toBe("insufficient evidence");
  expect(mixedCandidate.reasons).toContain(
    "insufficient evidence: 10 review trials graded before blocking recall; run `limitless eval regrade review-run` (no model calls)",
  );
});

test("the paired-comparison reference needs current grades and at least one valid prediction", () => {
  const legacy = (t: (typeof row.trials)[number]) => {
    const review = t.details.grade?.review;
    if (review) delete review.bySeverity;
  };
  const reference = (data: ReturnType<typeof input>) =>
    generatePolicy(data)
      .roles.filter((r) => r.role === "review")
      .flatMap((r) => r.candidates.map((c) => c.comparison.bestModel));
  // The local model has the higher current pass rate, but ten of its grades predate blocking recall.
  const row = evidence("review", [local, subscription]);
  for (const t of row.trials) {
    if (t.modelId === parseTarget(local).modelId && t.caseId < "case-10") legacy(t);
    if (t.modelId === parseTarget(subscription).modelId && t.caseId >= "case-30") t.pass = false;
  }
  expect(reference(input([row]))).toEqual([subscription, subscription]);
  // A model whose every trial errored has pass rate 0, not n/a, yet anchors nothing.
  const errored = evidence("review", [local, subscription]);
  for (const t of errored.trials)
    if (t.modelId === parseTarget(local).modelId)
      Object.assign(t, { status: "error", pass: false, details: {} });
    else legacy(t);
  const candidates = generatePolicy(input([errored])).roles.flatMap((r) => r.candidates);
  expect(candidates.find((c) => c.modelId === local)?.summary).toMatchObject({
    passRate: 0,
    predictionTrials: 0,
  });
  expect(reference(input([errored]))).toEqual([null, null]);
});

test("evidence renders an older daemon's review summary without the blocking-recall breakdown", () => {
  const evaluation = generatePolicy(input([evidence("review", [local])]));
  for (const c of evaluation.roles.flatMap((r) => r.candidates))
    if (c.summary.review) {
      const { bySeverity, underRated, ...older } = c.summary.review;
      c.summary.review = older as typeof c.summary.review;
    }
  const text = renderEvidence(evaluation);
  expect(text).toContain("blocking recall: 1.0000 (20/20)");
  expect(text).not.toContain("severity blocking recall");
  expect(text).not.toContain("under-rated");
});

test("missing required observations and incomplete pairs cannot become eligible", () => {
  for (const role of EVAL_ROLES) {
    const row = evidence(role);
    row.trials.forEach((t) => {
      t.details = {};
    });
    expect(first(input([row])).state).toBe("insufficient evidence");
    row.trials = [];
    const missing = first(input([row]));
    expect(missing.costPerCase).toBeNull();
    expect(missing.comparison.nonInferior).toBeNull();
  }
  const row = evidence("triage", [local], { k: 2 });
  row.trials = row.trials.filter((t) => t.trial === 0);
  expect(first(input([row])).comparison.pairedCases).toBe(0);
  expect(first(input([row])).state).toBe("insufficient evidence");
});

test("selected cross-run reference ignores excluded/unknown metadata and recomputes paired cases", () => {
  const a = evidence("triage", [local]);
  const b = evidence("triage", [subscription], { id: "sub", k: 2 });
  b.trials.slice(0, 4).forEach((t) => {
    t.pass = false;
  });
  const data = input([a, b]);
  const candidates = generatePolicy(data).roles[0]?.candidates ?? [];
  expect(candidates.every((c) => c.comparison.bestModel === local)).toBe(true);
  expect(candidates[0]?.comparison.pairedCases).toBe(40);
  data.settings.excludeOrigins = ["CN"];
  expect(
    generatePolicy(data).roles[0]?.candidates.every((c) => c.comparison.bestModel === subscription),
  ).toBe(true);
  const unknown = evidence("triage", ["unknown"], { id: "unknown" });
  expect(
    generatePolicy(input([unknown, b])).roles[0]?.candidates.every(
      (c) => c.comparison.bestModel === subscription,
    ),
  ).toBe(true);
  b.trials.forEach((t) => {
    t.caseId += "-different";
  });
  expect(
    generatePolicy(input([a, b])).roles[0]?.candidates.find((c) => c.modelId === subscription)?.state,
  ).toBe("insufficient evidence");
});

test("non-inferiority is strict at -delta, including the self-comparison when delta=0", () => {
  expect(pairedBootstrap([-0.1], { delta: 0.1 }).nonInferior).toBe(false);
  expect(first(input(undefined, { settings: evalSettings({ evals: { delta: 0 } }) })).eligible).toBe(false);
  const row = evidence("triage", [local, subscription]);
  row.trials
    .filter((t) => recordedTarget(t) === subscription)
    .slice(0, 20)
    .forEach((t) => {
      t.pass = false;
    });
  const rejected = generatePolicy(input([row])).roles[0]?.candidates.find((c) => c.modelId === subscription);
  expect(rejected?.reasons).toContain("non-inferiority not established");
});

test("costs normalize attempts over k, local=0, subscription weighting and original cache costs", () => {
  const row = evidence("triage", [local, subscription, metered], { k: 2 });
  let result = generatePolicy(input([row]));
  expect(result.generated.triage?.default).toEqual([local, subscription, metered]);
  expect(result.roles[0]?.candidates.find((c) => c.modelId === metered)?.costPerCase).toBeCloseTo(0.4);
  result = generatePolicy(input([row], { settings: evalSettings({ evals: { subscription_weight: 0.5 } }) }));
  expect(result.generated.triage?.default).toEqual([local, metered, subscription]);
  row.trials.forEach((t) => {
    t.details.cache = {
      evalRunId: "source",
      caseId: t.caseId,
      costUsd: t.costUsd,
      costEquivUsd: t.costEquivUsd,
      tokensIn: 1,
      tokensOut: 1,
      durationMs: t.durationMs,
    };
    t.costUsd = 0;
    t.costEquivUsd = 0;
  });
  result = generatePolicy(input([row]));
  const sub = result.roles[0]?.candidates.find((c) => c.modelId === subscription);
  expect(sub?.costPerCase).toBe(0.25);
  expect(sub?.costDenominator).toBe(80);
  expect(sub?.summary.costEquivUsd).toBe(0);
  expect(sub?.summary.p50LatencyMs).toBeNull();
});

test("attempted failures count in costs; skips and preparation failures do not; latency excludes interruptions", () => {
  const row = evidence("triage", [metered]);
  const base = row.trials[0];
  if (!base) throw new Error("missing fixture");
  row.trials.push(
    {
      ...base,
      caseId: "failure",
      status: "error",
      pass: false,
      costUsd: 2,
      durationMs: 500,
      details: { interrupted: true },
    },
    { ...base, caseId: "skip", status: "skipped", pass: null, costUsd: 99, details: {} },
    {
      ...base,
      caseId: "prep",
      status: "error",
      pass: null,
      costUsd: 99,
      details: { preparationFailed: true },
    },
  );
  const c = first(input([row]));
  expect(c.costDenominator).toBe(41);
  expect(c.costPerCase).toBeCloseTo(18 / 41);
  expect(c.summary.latencyDenominator).toBe(40);
  expect(c.summary.predictionTrials).toBe(40);
  row.trials[0] = { ...base, costUsd: Number.NaN };
  expect(first(input([row])).reasons).toContain("applicable cost estimate unavailable");
});

test("ordering resolves equal cost by latency, known before null, then ID", () => {
  const row = evidence("triage", [metered, subscription, local]);
  row.trials.forEach((t) => {
    t.costUsd = 0;
    t.costEquivUsd = 0;
  });
  expect(generatePolicy(input([row])).generated.triage?.default).toEqual([subscription, local, metered]);
  row.trials
    .filter((t) => recordedTarget(t) === metered)
    .forEach((t) => {
      t.durationMs = 1;
    });
  expect(generatePolicy(input([row])).generated.triage?.default?.[0]).toBe(metered);
  row.trials
    .filter((t) => recordedTarget(t) === subscription)
    .forEach((t) => {
      t.details.cache = {
        evalRunId: "cached",
        caseId: t.caseId,
        costUsd: 0,
        costEquivUsd: 0,
        durationMs: 1,
        tokensIn: 0,
        tokensOut: 0,
      };
    });
  expect(generatePolicy(input([row])).generated.triage?.default).toEqual([metered, local, subscription]);
});

for (const [origin, baseOrigin, exclusions, eligible] of [
  ["CN", "US", ["CN"], false],
  ["US", "CN", ["CN"], false],
  ["US", "unknown", [], false],
  ["US", "unknown", undefined, true],
  ["US", "US", ["CN"], true],
] as const)
  test(`origin=${origin}, base=${baseOrigin}, exclusions=${exclusions}`, () => {
    const models = MODELS.map((m) =>
      m.id === parseTarget(local).modelId ? { ...m, origin, baseOrigin } : m,
    );
    const settings = evalSettings({
      routing: exclusions === undefined ? {} : { exclude_origins: exclusions },
    });
    expect(first(input(undefined, { models, settings })).eligible).toBe(eligible);
  });

test("all-ineligible roles preserve current policy and unrelated overrides; chains hold eligible models plus at most one availability fallback", () => {
  const current = { triage: { default: [subscription] }, review: { large: [local] } };
  const result = generatePolicy(
    input([evidence("triage", [local])], {
      settings: evalSettings({ routing: { exclude_origins: ["CN"] } }),
    }),
  );
  const next = proposedOverlay(current, result);
  expect(next).toEqual(current);
  expect(overlayPolicy(DEFAULT_POLICY, next)).toEqual(overlayPolicy(DEFAULT_POLICY, current));
  expect(result.roles[0]?.decision).toContain("unchanged: no eligible");
  expect(result.roles[1]?.decision).toContain("no completed evidence");
  for (const role of generatePolicy(input([evidence("triage", [local, subscription])])).roles)
    expect(
      role.order.every(
        (id) =>
          role.candidates.find((c) => c.modelId === id)?.eligible || role.availabilityFallbacks.includes(id),
      ),
    ).toBe(true);
});

test("matrix uses generator decisions, latest completed links, and unevaluated catalog candidates", () => {
  const old = evidence("triage", [local, subscription]);
  const latest = evidence("triage", [local], { id: "latest", finishedAt: 3000 });
  const missing = evidence("review", [metered]);
  missing.trials = [];
  const rows = [
    old,
    latest,
    missing,
    evidence("triage", [local], { id: "failed", status: "failed", finishedAt: 4000 }),
    evidence("triage", [local], { id: "running", status: "running", finishedAt: 5000 }),
  ];
  for (const settings of [
    evalSettings({}),
    evalSettings({ routing: { exclude_origins: ["CN"] }, evals: { floors: { triage_pass_rate: 1 } } }),
  ]) {
    const data = response(rows, { settings });
    const matrix = evalMatrix(data);
    expect(matrix.models).toContain("openrouter/ministral-14b-2512");
    for (const row of matrix.rows)
      for (const cell of row.cells) {
        const core = data.evaluation.roles
          .find((r) => r.role === row.role)
          ?.candidates.find((c) => c.modelId === cell.modelId);
        expect(cell.state).toBe(core?.state ?? "no result");
        expect(cell.href).toBe(core ? `/evals/${core.run.id}` : null);
      }
    expect(matrix.rows[0]?.cells.find((c) => c.modelId === local)?.href).toBe("/evals/latest");
    expect(matrix.rows[1]?.cells.find((c) => c.modelId === metered)?.state).toBe("insufficient evidence");
  }
});

test("evidence rendering is reproducible and documents selected runs, missing metrics, exclusions and unchanged roles", () => {
  const triage = evidence("triage", [local, subscription]);
  const review = evidence("review", [metered, subscription]);
  const verify = evidence("verify", [subscription]);
  verify.trials = [];
  review.trials
    .filter((t) => recordedTarget(t) === subscription)
    .forEach((t) => {
      t.pass = false;
    });
  triage.trials
    .filter((t) => recordedTarget(t) === subscription)
    .forEach((t) => {
      t.details.cache = {
        evalRunId: "cached",
        caseId: t.caseId,
        costUsd: 1,
        costEquivUsd: 1,
        durationMs: 1,
        tokensIn: 0,
        tokensOut: 0,
      };
      t.costUsd = 0;
      t.costEquivUsd = 0;
    });
  const result = generatePolicy(
    input([triage, review, verify], { settings: evalSettings({ routing: { exclude_origins: ["CN"] } }) }),
  );
  const markdown = renderEvidence(result);
  expect(markdown).toBe(renderEvidence(result));
  expect(markdown).toMatchSnapshot();
  for (const text of [
    "Wilson 95%",
    "subscription",
    "cached=40",
    "origin excluded",
    "n/a",
    "verify unchanged",
    "run=triage-run",
    "created=1970-01-01T00:00:01.000Z",
    "prediction coverage",
    "non-inferiority not established",
    "attempts=40",
    "seed=20260926",
  ])
    expect(markdown).toContain(text);
  expect(wilson(0, 0)).toBeNull();
});

test("missing provider metadata and absent applicable cache estimates are ineligible; error predictions stay excluded", () => {
  const row = evidence("review", [metered]);
  const noProvider = first(input([row], { providers: [] }));
  expect(noProvider.reasons).toContain("catalog/provider metadata unavailable");
  expect(noProvider.comparison.bestModel).toBeNull();
  expect(noProvider.eligible).toBe(false);
  const base = row.trials[0];
  if (!base) throw new Error("missing fixture");
  row.trials.push({ ...base, caseId: "invalid-call", status: "error", pass: false, details: {} });
  const c = first(input([row]));
  expect(c.summary.review?.defectRecall.denominator).toBe(20);
  expect(c.summary.evaluatedTrials).toBe(41);
  expect(c.summary.predictionCoverage).toBeCloseTo(40 / 41);
  base.details.cache = {
    evalRunId: "source",
    caseId: base.caseId,
    costUsd: NaN,
    costEquivUsd: 1,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 1,
  };
  expect(first(input([row])).costPerCase).toBeNull();
});

test("hard rejections are ineligible, not insufficient evidence, even without an allowed reference", () => {
  const lone = generatePolicy(input([evidence("review", [metered])], { providers: [] })).roles[1];
  expect(lone?.order).toEqual([]);
  expect(lone?.candidates[0]?.state).toBe("ineligible");
  expect(lone?.candidates[0]?.reasons).toEqual([
    "catalog/provider metadata unavailable",
    "applicable cost estimate unavailable",
  ]);
  const origins = [...new Set(MODELS.flatMap((m) => [m.origin, m.baseOrigin]))];
  const excluded = generatePolicy(
    input([evidence("triage", [local, subscription])], {
      settings: evalSettings({ routing: { exclude_origins: origins } }),
    }),
  ).roles[0];
  expect(excluded?.order).toEqual([]);
  expect(excluded?.decision).toContain("unchanged");
  for (const c of excluded?.candidates ?? []) {
    expect(c.state).toBe("ineligible");
    expect(c.reasons.some((r) => r.startsWith("origin excluded"))).toBe(true);
    expect(c.reasons.some((r) => r.startsWith("insufficient evidence"))).toBe(false);
  }
  expect(excluded?.candidates).toHaveLength(2);
});

test("a ceiling the dataset is too small to establish is insufficient evidence, not a pass", () => {
  const row = evidence("verify");
  row.trials = row.trials.slice(0, 1);
  for (const t of row.trials) if (t.details.grade?.verify) t.details.grade.verify.falseAccepts = 0;
  const settings = evalSettings({ evals: { floors: { verify_false_accept_rate: 0.1 } } });
  const result = first(input([row], { settings }));
  expect(result.eligible).toBe(false);
  expect(result.state).toBe("insufficient evidence");
  expect(result.reasons.join()).toContain("cannot establish");
});

test("policy selects latest evidence per effort, costs them independently and rejects unknown history", async () => {
  const { validatePolicy } = await import("../src/router/policy.ts");
  const low = evidence("triage", ["codex/luna@low"], { id: "low-old" });
  const high = evidence("triage", ["codex/luna@high"], { id: "high", finishedAt: 4000 });
  const newerLow = evidence("triage", ["codex/luna@low"], { id: "low-new", finishedAt: 3000 });
  const legacy = evidence("triage", ["codex/luna"], { id: "legacy", finishedAt: 5000 });
  for (const t of legacy.trials) t.effort = null;
  const unsupported = evidence("triage", ["codex/luna@max"], { id: "unsupported" });
  for (const t of high.trials) t.costEquivUsd = 10;
  for (const t of low.trials) t.pass = false;
  const data = input([high, low, newerLow, legacy, unsupported]);
  // max is intentionally not a declared Luna setting.
  const result = generatePolicy(data);
  const candidates = result.roles[0]?.candidates ?? [];
  expect(candidates.find((c) => c.modelId === "codex/luna@low")?.run.id).toBe("low-new");
  expect(candidates.find((c) => c.modelId === "codex/luna@high")?.run.id).toBe("high");
  expect(result.generated.triage?.default).toEqual(["codex/luna@low", "codex/luna@high"]);
  expect(candidates.find((c) => c.modelId === "codex/luna (unknown effort)")?.reasons).toContain(
    "legacy evidence with unknown effort",
  );
  expect(candidates.find((c) => c.modelId === "codex/luna@max")?.reasons).toContain(
    "unsupported recorded effort max",
  );
  expect(validatePolicy(result.generated, MODELS)).toEqual(result.generated);
  expect(generatePolicy({ ...data, evidence: [...data.evidence].reverse() }).generated).toEqual(
    result.generated,
  );
  const matrix = evalMatrix(response(data.evidence));
  expect(matrix.rows[0]?.cells.find((c) => c.modelId === "codex/luna@low")?.href).toBe("/evals/low-new");
  expect(matrix.rows[0]?.cells.find((c) => c.modelId === "codex/luna@high")?.href).toBe("/evals/high");
});

test("fresh bare evals of models without a default effort qualify; legacy unknown effort does not", () => {
  const fresh = evidence("triage", ["claude/opus", "codex/luna@medium"], { id: "fresh", finishedAt: 3000 });
  const legacy = evidence("triage", ["claude/sonnet"], { id: "legacy" });
  for (const t of legacy.trials) t.effort = null;
  const result = generatePolicy(input([fresh, legacy]));
  const candidates = result.roles[0]?.candidates ?? [];
  expect(fresh.trials.find((t) => t.modelId === "claude/opus")?.effort).toBe("default");
  expect(candidates.find((c) => c.modelId === "claude/opus")?.eligible).toBe(true);
  expect(candidates.find((c) => c.modelId === "claude/sonnet (unknown effort)")?.reasons).toContain(
    "legacy evidence with unknown effort",
  );
  expect(result.generated.triage?.default).toContain("claude/opus");
  expect(result.generated.triage?.default).not.toContain("claude/sonnet");
  // A saved "default" is not reinterpreted once the catalog gains a default effort.
  const models = MODELS.map((m) => (m.id === "claude/opus" ? { ...m, effort: "high" as const } : m));
  const changed = generatePolicy({ ...input([fresh]), models });
  expect(changed.roles[0]?.candidates.find((c) => c.modelId === "claude/opus")?.eligible).toBe(false);
});

test("legacy unknown-effort rows never pool with or displace backend-default evidence", async () => {
  const { validatePolicy } = await import("../src/router/policy.ts");
  // One run holding one backend-default trial and 39 legacy unknown-effort trials.
  const mixed = evidence("triage", ["claude/opus"], { id: "mixed" });
  for (const t of mixed.trials.slice(1)) t.effort = null;
  const result = generatePolicy(input([mixed]));
  const candidates = result.roles[0]?.candidates ?? [];
  const known = candidates.find((c) => c.modelId === "claude/opus");
  const unknown = candidates.find((c) => c.modelId === "claude/opus (unknown effort)");
  expect(known?.summary.evaluatedTrials).toBe(1);
  expect(known?.summary.effort).toBe("default");
  expect(known?.eligible).toBe(false);
  expect(unknown?.summary.evaluatedTrials).toBe(39);
  expect(unknown?.summary.effort).toBeNull();
  expect(unknown?.state).toBe("ineligible");
  expect(unknown?.reasons).toContain("legacy evidence with unknown effort");
  expect(result.generated.triage).toBeUndefined();

  // Newer unknown-effort evidence cannot displace older backend-default evidence.
  const known40 = evidence("triage", ["claude/opus"], { id: "known", finishedAt: 2000 });
  const legacy = evidence("triage", ["claude/opus"], { id: "legacy", finishedAt: 5000 });
  for (const t of legacy.trials) t.effort = null;
  expect(selectEvidence([legacy, known40]).map((e) => [e.modelId, e.run.id])).toEqual([
    ["claude/opus", "known"],
    ["claude/opus (unknown effort)", "legacy"],
  ]);
  const later = generatePolicy(input([legacy, known40]));
  const selected = later.roles[0]?.candidates.find((c) => c.modelId === "claude/opus");
  expect(selected?.run.id).toBe("known");
  expect(selected?.summary.evaluatedTrials).toBe(40);
  expect(later.generated.triage?.default).toEqual(["claude/opus"]);
  expect(validatePolicy(later.generated, MODELS)).toEqual(later.generated);
});

test("effort a role's transport cannot deliver is never emitted", () => {
  const review = evidence("review", ["openrouter/gpt-6-luna@low", "openrouter/gpt-6-luna"]);
  const triage = evidence("triage", ["openrouter/gpt-6-luna@low"]);
  const result = generatePolicy(input([review, triage]));
  const reviewRole = result.roles.find((r) => r.role === "review");
  expect(
    reviewRole?.candidates.find((c) => c.modelId === "openrouter/gpt-6-luna@low")?.reasons.join(),
  ).toContain("cannot carry effort in the review role");
  expect(result.generated.review?.default).toEqual(["openrouter/gpt-6-luna"]);
  // Tool-less triage runs over HTTP, which carries OpenRouter reasoning effort.
  expect(result.generated.triage?.default).toEqual(["openrouter/gpt-6-luna@low"]);
  expect(validatePolicy(result.generated, MODELS)).toEqual(result.generated);
});

test("an availability fallback from another provider is appended only when it fails nothing but non-inferiority", () => {
  const degrade = (row: ReturnType<typeof evidence>, modelId: string, failing: number) => {
    const id = parseTarget(modelId).modelId;
    for (const t of row.trials.filter((t) => t.modelId === id).slice(0, failing)) {
      t.pass = false;
      if (t.details.grade) {
        t.details.grade.pass = false;
        t.details.grade.score = 0;
      }
    }
    return row;
  };
  const triage = (rows: ReturnType<typeof evidence>) => generatePolicy(input([rows])).roles[0];
  // 32/40: clears the 0.60 floor (Wilson lower ~0.65) but is not within 0.10 of a perfect model.
  const fallback = triage(degrade(evidence("triage", [metered, local]), local, 8));
  expect(fallback?.order).toEqual([metered, local]);
  expect(fallback?.availabilityFallbacks).toEqual([local]);
  expect(fallback?.decision).toContain("availability fallback");
  // 20/40 fails the floor itself, so it is never added.
  const floorFail = triage(degrade(evidence("triage", [metered, local]), local, 20));
  expect(floorFail?.order).toEqual([metered]);
  expect(floorFail?.availabilityFallbacks).toEqual([]);
  // A candidate on a provider the chain already uses adds no availability.
  const gemma = "openrouter/gemma-4-31b-it";
  const sameProvider = triage(degrade(evidence("triage", [metered, gemma]), gemma, 8));
  expect(sameProvider?.order).toEqual([metered]);
  expect(sameProvider?.availabilityFallbacks).toEqual([]);
});

test("implement cells use separate complexity evidence, preserve defaults, and explain rejections", () => {
  const rows = (["trivial", "small", "medium"] as const).map((complexity, index) => {
    const row = evidence("implement", [local, subscription, metered], {
      id: complexity,
      finishedAt: 2000 + index,
    });
    for (const t of row.trials) t.details.complexity = complexity;
    if (complexity === "small")
      for (const t of row.trials.filter((t) => recordedTarget(t) === local).slice(0, 20)) t.pass = false;
    if (complexity === "medium")
      for (const t of row.trials.filter((t) => recordedTarget(t) === subscription).slice(0, 8))
        t.pass = false;
    return row;
  });
  const result = generatePolicy(input(rows));
  expect(result.generated.implement).toEqual({
    trivial: [local, subscription, metered],
    small: [subscription, metered],
    medium: [local, metered, subscription],
  });
  const markdown = renderEvidence(result);
  expect(markdown).toContain("## implement.small");
  expect(markdown).toContain("pass rate lower bound");
  expect(markdown).toContain("non-inferiority not established");
  expect(markdown).toContain("availability fallbacks");
  expect(markdown).toContain("run=medium");
  const current = { implement: { default: [subscription], large: [metered] }, chat: { small: [local] } };
  const overlay = proposedOverlay(current, result);
  expect(overlay.implement?.large).toEqual([metered]);
  expect(overlay.implement?.default).toEqual([subscription]);
  expect(overlay.chat).toEqual(current.chat);
  expect(validatePolicy(overlay, MODELS)).toEqual(overlay);
});

test("matrix exposes each implement decision, comparison, cost, and availability fallback", () => {
  const row = evidence("implement", [metered, local]);
  for (const trial of row.trials) {
    trial.details.complexity = "small";
    if (recordedTarget(trial) === local && Number(trial.caseId.slice(-2)) < 8) trial.pass = false;
  }
  const matrix = evalMatrix(response([row]));
  expect(matrix.rows.filter((r) => r.role.startsWith("implement.")).map((r) => r.role)).toEqual([
    "implement.trivial",
    "implement.small",
    "implement.medium",
  ]);
  const small = matrix.rows.find((r) => r.role === "implement.small");
  expect(small?.decision).toContain("availability fallbacks");
  const paid = small?.cells.find((c) => c.modelId === metered);
  expect(paid?.costPerCase).toBeCloseTo(0.4);
  expect(paid).toMatchObject({
    state: "eligible",
    availabilityFallback: false,
    href: "/evals/implement-run",
  });
  expect(small?.cells.find((c) => c.modelId === local)).toMatchObject({
    state: "ineligible",
    costPerCase: 0,
    availabilityFallback: true,
    comparison: { nonInferior: false, pairedCases: 40 },
  });
  expect(matrix.rows.find((r) => r.role === "implement")?.cells.find((c) => c.modelId === local)?.state).toBe(
    "no result",
  );
});

test("implement sparse or unpaired evidence never replaces an existing cell", () => {
  const good = evidence("implement", [subscription], { id: "good" });
  good.trials.forEach((t) => {
    t.details.complexity = "trivial";
  });
  const sparse = evidence("implement", [local], { id: "sparse", k: 2 });
  sparse.trials.forEach((t) => {
    t.details.complexity = "small";
  });
  sparse.trials = sparse.trials.filter((t) => t.trial === 0);
  const result = generatePolicy(input([good, sparse]));
  expect(result.generated.implement).toEqual({ trivial: [subscription] });
  const current = { implement: { small: [metered] } };
  expect(proposedOverlay(current, result).implement?.small).toEqual([metered]);
  expect(overlayPolicy(DEFAULT_POLICY, proposedOverlay(current, result)).implement.medium).toEqual(
    DEFAULT_POLICY.implement.medium,
  );
});

test.each(["triage", "implement"] as const)(
  "%s rejects provider drift for eligibility, references, costs, and availability",
  (role) => {
    for (const failures of [0, 8]) {
      for (const mixed of [false, true]) {
        const row = evidence(role, [subscription, metered]);
        for (const t of row.trials) {
          t.details.complexity = "small";
          t.details.provider = t.modelId === metered ? "openrouter" : "codex";
          if (t.modelId === metered && Number(t.caseId.slice(-2)) < failures) t.pass = false;
          if (recordedTarget(t) === subscription && t.caseId === "case-00") t.pass = false;
        }
        const cell = role === "implement" ? "small" : "default";
        const matching = generatePolicy(input([row]));
        expect(matching.generated[role]?.[cell]).toEqual([subscription, metered]);
        const models = MODELS.map((m) => (m.id === metered ? { ...m, provider: "twilight" } : m));
        // Even one mismatching row must reject a target whose other rows match the new provider.
        if (mixed)
          for (const t of row.trials)
            if (t.modelId === metered && t.caseId !== "case-39") t.details.provider = "twilight";
        const result = generatePolicy(input([row], { models }));
        const decision = result.roles.find((r) => r.role === role && r.cell === cell);
        const rejected = decision?.candidates.find((c) => c.modelId === metered);
        expect(result.generated[role]?.[cell]).toEqual([subscription]);
        expect(decision?.availabilityFallbacks).toEqual([]);
        expect(decision?.candidates.every((c) => c.comparison.bestModel === subscription)).toBe(true);
        expect(rejected?.state).toBe("ineligible");
        expect(rejected?.costPerCase).toBeNull();
        expect(rejected?.billing).toBeNull();
        expect(rejected?.summary.costUsd).toBeCloseTo(16);
        const reason = "recorded provider openrouter differs from catalog provider twilight";
        expect(rejected?.reasons).toContain(reason);
        expect(renderEvidence(result)).toContain(reason);
      }
    }
  },
);

test("implement rejects the exact non-inferiority margin and limits provider fallbacks", () => {
  const twilight = "twilight/qwen-27b";
  const otherSubscription = "codex/luna@low";
  const row = evidence("implement", [metered, subscription, local, otherSubscription, twilight], { k: 10 });
  for (const t of row.trials) {
    t.details.complexity = "medium";
    if (recordedTarget(t) !== metered && t.trial === 0) t.pass = false;
  }
  const result = generatePolicy(input([row]));
  const cell = result.roles.find((r) => r.role === "implement" && r.cell === "medium");
  expect(cell?.candidates.find((c) => c.modelId === local)?.comparison.lowerBound).toBeCloseTo(-0.1);
  expect(cell?.order).toEqual([metered, local, twilight, otherSubscription]);
  expect(cell?.availabilityFallbacks).toEqual([local, twilight, otherSubscription]);
  expect(cell?.order).not.toContain(subscription);
  expect(renderEvidence(result)).toContain("lower=-0.1000");
});

test("implement effort recovery needs significant paired B1 evidence at no greater cost", () => {
  const low = "codex/luna@low";
  const high = "codex/luna@high";
  const row = evidence("implement", [low, high, metered]);
  for (const t of row.trials) {
    t.details.complexity = "small";
    if (recordedTarget(t) === high) t.costEquivUsd = 4;
  }
  const base = {
    complexity: "small" as const,
    low,
    high,
    switch: metered,
    pairedCases: 40,
    lowerBound: 0.05,
    effortCost: 0.2,
    switchCost: 0.2,
  };
  const ordinary = generatePolicy(input([row]));
  expect(ordinary.generated.implement?.small).toEqual([low, metered, high]);
  const recovered = generatePolicy(input([row], { escalation: [base] }));
  expect(recovered.generated.implement?.small).toEqual([low, high, metered]);
  expect(renderEvidence(recovered)).toContain("B1 recovery lower=0.0500");
  const costlier = generatePolicy(input([row], { escalation: [{ ...base, effortCost: 0.21 }] }));
  expect(costlier.generated.implement?.small).toEqual([low, metered, high]);
  const smallEvidence = renderEvidence(costlier).split("## implement.small")[1]?.split("## ")[0];
  expect(smallEvidence).toContain(
    `${low} → ${high} before ${metered} withheld: effort cost=0.2100 exceeds switch cost=0.2000`,
  );
  expect(smallEvidence).toContain("despite significant B1 recovery (lower=0.0500, paired=40)");
  expect(smallEvidence).not.toContain("no qualifying B1 paired recovery evidence");
  for (const change of [{ lowerBound: 0 }, { pairedCases: 0 }, { effortCost: 0.21 }])
    expect(
      generatePolicy(input([row], { escalation: [{ ...base, ...change }] })).generated.implement?.small,
    ).toEqual(ordinary.generated.implement?.small);
});

test("each uncovered provider contributes at most one availability fallback", () => {
  const twilight = "twilight/qwen-27b@none";
  const mtplx = "mtplx/qwen-27b@none";
  const row = evidence("triage", [metered, twilight, mtplx]);
  for (const id of [twilight, mtplx].map((m) => parseTarget(m).modelId))
    for (const t of row.trials.filter((t) => t.modelId === id).slice(0, 8)) {
      t.pass = false;
      if (t.details.grade) {
        t.details.grade.pass = false;
        t.details.grade.score = 0;
      }
    }
  const role = generatePolicy(input([row])).roles[0];
  // Both local providers are uncovered by the eligible chain, so each adds one fallback after it.
  expect(role?.order[0]).toBe(metered);
  expect(new Set(role?.availabilityFallbacks)).toEqual(new Set([twilight, mtplx]));
  expect(role?.order.slice(1)).toEqual(role?.availabilityFallbacks);
});

test("implement cells use their own pass-rate floor", async () => {
  const { evalSettings } = await import("../src/evals/settings.ts");
  const settings = evalSettings({ evals: { floors: { implement_pass_rate: 0.9 } } });
  expect(settings.floors.implement_pass_rate).toBe(0.9);
  expect(settings.floors.triage_pass_rate).toBe(0.6);
  expect(evalSettings({}).floors.implement_pass_rate).toBe(0.6);
});

test("only review systems matching [review] implementer_report are routing evidence", () => {
  const system = (name: string, target: string, implementerReport: "include" | "omit" = "include") => ({
    name,
    mode: "single" as const,
    finders: [{ target, prompt: "standard" as const }],
    implementerReport,
  });
  const base = evidence("review", [local, metered]);
  const withSystems = (systems: ReturnType<typeof system>[]) => {
    const trials = systems.flatMap((s) =>
      base.trials
        .filter((t) => recordedTarget(t) === s.finders[0]?.target)
        .map((t) => ({
          ...t,
          pass: s.implementerReport === "include",
          details: { ...t.details, system: s.name },
        })),
    );
    return { run: { ...base.run, systems }, trials };
  };
  // Include and omit side by side on one target, and an omit-only target.
  const run = withSystems([system("A", local), system("B", local, "omit"), system("M", metered, "omit")]);
  const chosen = (mode?: "include" | "omit") =>
    selectEvidence([run], undefined, mode).map((e) => [
      e.modelId,
      [...new Set(e.trials.filter((t) => recordedTarget(t) === e.modelId).map((t) => t.details.system))],
    ]);
  expect(chosen()).toEqual([[local, ["A"]]]);
  expect(chosen("include")).toEqual([[local, ["A"]]]);
  expect(chosen("omit")).toEqual([
    [local, ["B"]],
    [metered, ["M"]],
  ]);
  const review = (mode?: "include" | "omit") =>
    generatePolicy(input([run], mode ? { implementerReport: mode } : {})).roles.find(
      (r) => r.role === "review",
    )?.candidates ?? [];
  expect(review().map((c) => [c.modelId, c.summary.candidate, c.summary.passRate])).toEqual([
    [local, "A", 1],
  ]);
  expect(review("omit").map((c) => [c.modelId, c.summary.candidate, c.summary.passRate])).toEqual([
    [local, "B", 0],
    [metered, "M", 0],
  ]);
  // Legacy review runs have no systems and still count.
  expect(selectEvidence([base], undefined, "omit").map((e) => e.modelId)).toEqual([local, metered]);
});
