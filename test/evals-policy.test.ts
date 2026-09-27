import { expect, test } from "bun:test";
import { proposedOverlay, renderEvidence } from "../src/evals/evidence.ts";
import { EVAL_ROLES, generatePolicy, selectEvidence } from "../src/evals/policy.ts";
import { evalSettings } from "../src/evals/settings.ts";
import { pairedBootstrap, wilson } from "../src/evals/stats.ts";
import { DEFAULT_POLICY, MODELS } from "../src/router/catalog.ts";
import { overlayPolicy } from "../src/router/policy.ts";
import { evalMatrix } from "../ui/lib/evals.ts";
import { evidence, input, local, metered, response, subscription } from "./evals-policy-support.ts";

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
  const ignored = (["running", "queued", "failed", "budget_exhausted"] as const).map((status) =>
    evidence("triage", [local], { id: status, status, finishedAt: 9999 }),
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
});

for (const [role, field, bound] of [
  ["triage", "triage_pass_rate", "lower"],
  ["triage", "triage_risk_under_call_rate", "upper"],
  ["review", "review_defect_recall", "lower"],
  ["review", "review_clean_false_block_rate", "upper"],
  ["verify", "verify_false_accept_rate", "upper"],
] as const)
  test(`${field}: inclusive Wilson boundary and rejection beyond it`, () => {
    const rows = [evidence(role)];
    const initial = first(input(rows));
    const index =
      field === "triage_risk_under_call_rate" || field === "review_clean_false_block_rate" ? 1 : 0;
    const ci = initial.metrics[index]?.ci;
    if (!ci) throw new Error("missing interval");
    const threshold = ci[bound === "lower" ? 0 : 1];
    const settings = evalSettings({ evals: { floors: { [field]: threshold } } });
    expect(first(input(rows, { settings })).eligible).toBe(true);
    settings.floors[field] = threshold + (bound === "lower" ? 0.0001 : -0.0001);
    expect(first(input(rows, { settings })).eligible).toBe(false);
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
    .filter((t) => t.modelId === subscription)
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
    .filter((t) => t.modelId === metered)
    .forEach((t) => {
      t.durationMs = 1;
    });
  expect(generatePolicy(input([row])).generated.triage?.default?.[0]).toBe(metered);
  row.trials
    .filter((t) => t.modelId === subscription)
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
    const models = MODELS.map((m) => (m.id === local ? { ...m, origin, baseOrigin } : m));
    const settings = evalSettings({
      routing: exclusions === undefined ? {} : { exclude_origins: exclusions },
    });
    expect(first(input(undefined, { models, settings })).eligible).toBe(eligible);
  });

test("all-ineligible roles preserve current policy and unrelated overrides; generated chains contain only eligible models", () => {
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
    expect(role.order.every((id) => role.candidates.find((c) => c.modelId === id)?.eligible)).toBe(true);
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
    .filter((t) => t.modelId === subscription)
    .forEach((t) => {
      t.pass = false;
    });
  triage.trials
    .filter((t) => t.modelId === subscription)
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
