import type { EvalRun, EvalTrial } from "../core/types.ts";
import { evidenceTarget, recordedTarget } from "../router/targets.ts";

export interface StatsOptions {
  delta?: number;
  seed?: number;
  resamples?: number;
}
export const DEFAULT_STATS = { delta: 0.1, seed: 20260926, resamples: 10_000 };
export function statsOptions(options: StatsOptions = {}) {
  const result = { ...DEFAULT_STATS, ...options };
  if (!Number.isFinite(result.delta) || result.delta < 0 || result.delta > 1)
    throw new Error("delta must be in [0,1]");
  if (!Number.isInteger(result.seed) || result.seed < 0 || result.seed > 0xffffffff)
    throw new Error("seed must be a uint32");
  if (!Number.isSafeInteger(result.resamples) || result.resamples < 1)
    throw new Error("resamples must be a positive integer");
  return result;
}
export function wilson(passed: number, total: number): [number, number] | null {
  if (!Number.isInteger(total) || !Number.isInteger(passed) || total < 0 || passed < 0 || passed > total)
    throw new Error("invalid pass counts");
  if (!total) return null;
  const z = 1.959963984540054;
  const p = passed / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const radius = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}
const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function pairedBootstrap(differences: number[], options: StatsOptions = {}) {
  const settings = statsOptions(options);
  if (differences.some((n) => !Number.isFinite(n) || n < -1 || n > 1))
    throw new Error("invalid paired difference");
  if (!differences.length)
    return { meanDifference: null, lowerBound: null, nonInferior: null, pairedCases: 0, ...settings };
  const random = rng(settings.seed);
  const means: number[] = [];
  for (let r = 0; r < settings.resamples; r++) {
    let sum = 0;
    for (let i = 0; i < differences.length; i++)
      sum += differences[Math.floor(random() * differences.length)] ?? 0;
    means.push(sum / differences.length);
  }
  means.sort((a, b) => a - b);
  // Nearest-rank fifth percentile (one-sided 95% lower bound).
  const lowerBound = means[Math.max(0, Math.ceil(settings.resamples * 0.05) - 1)] ?? 0;
  return {
    meanDifference: mean(differences),
    lowerBound,
    nonInferior: lowerBound > -settings.delta,
    pairedCases: differences.length,
    ...settings,
  };
}
export function completeCases(trials: EvalTrial[], k: number) {
  const groups = new Map<string, EvalTrial[]>();
  for (const trial of trials) {
    if (trial.pass === null || !["ok", "error"].includes(trial.status)) continue;
    const group = groups.get(trial.caseId) ?? [];
    group.push(trial);
    groups.set(trial.caseId, group);
  }
  return new Map(
    [...groups].filter(([, group]) => group.length === k && new Set(group.map((t) => t.trial)).size === k),
  );
}
/** Prediction metrics pool labeled observations, excluding failed/invalid invocations. */
function roleMetrics(run: EvalRun, rows: EvalTrial[]) {
  const valid = rows.filter((t) => t.status === "ok" && t.details.grade);
  const review = valid.flatMap((t) => (t.details.grade?.review ? [t.details.grade.review] : []));
  const verify = valid.flatMap((t) => (t.details.grade?.verify ? [t.details.grade.verify] : []));
  const rate = (numerator: number, denominator: number) => ({
    numerator,
    denominator,
    rate: denominator ? numerator / denominator : null,
  });
  const matched = review.reduce((n, r) => n + r.requiredMatched, 0);
  const total = review.reduce((n, r) => n + r.requiredTotal, 0);
  const clean = review.filter((r) => r.falseBlock !== null);
  return {
    predictionTrials: valid.length,
    predictionCoverage: rows.length ? valid.length / rows.length : null,
    scheduledTrials: rows.length,
    review:
      run.role === "review"
        ? {
            defectRecall: { ...rate(matched, total), ci: wilson(matched, total) },
            falseBlock: rate(clean.filter((r) => r.falseBlock).length, clean.length),
            verdictAccuracy: rate(review.filter((r) => r.verdictMatch).length, review.length),
          }
        : null,
    verify:
      run.role === "verify"
        ? {
            falseAccept: rate(
              verify.reduce((n, r) => n + r.falseAccepts, 0),
              verify.reduce((n, r) => n + r.unmetTotal, 0),
            ),
            falseReject: rate(
              verify.reduce((n, r) => n + r.falseRejects, 0),
              verify.reduce((n, r) => n + r.metTotal, 0),
            ),
            criterionAccuracy: rate(
              verify.reduce((n, r) => n + r.matched, 0),
              verify.reduce((n, r) => n + r.total, 0),
            ),
          }
        : null,
  };
}
function implementMetrics(rows: EvalTrial[]) {
  const evaluated = rows.filter((t) => t.pass !== null && ["ok", "error"].includes(t.status));
  const executed = evaluated.filter(
    (t) => !t.details.cache && !t.details.interrupted && !t.details.preparationFailed,
  );
  const first = (t: EvalTrial) =>
    t.details.rounds?.[0] ?? {
      pass: t.pass,
      reason: t.details.grade?.implement?.reason,
    };
  const initialFailures = evaluated.filter(
    (t) => first(t).pass === false && ["gates", "audit", "hidden_tests"].includes(first(t).reason ?? ""),
  );
  const attempted = initialFailures.filter((t) =>
    t.details.rounds?.slice(1).some((r) => r.status === "ok" && r.pass !== null),
  );
  const recoveryExecutions = attempted.filter((t) => !t.details.cache);
  const recovered = initialFailures.filter((t) => t.pass).length;
  const executedRecoveries = recoveryExecutions.filter((t) => t.pass).length;
  const rate = (numerator: number, denominator: number) => ({
    numerator,
    denominator,
    rate: denominator ? numerator / denominator : null,
    ci: wilson(numerator, denominator),
  });
  const recoveryCost = (key: "costUsd" | "costEquivUsd") =>
    executedRecoveries
      ? recoveryExecutions.reduce(
          (sum, t) => sum + (t.details.rounds ?? []).slice(1).reduce((n, r) => n + r[key], 0),
          0,
        ) / executedRecoveries
      : null;
  return {
    passAt1: rate(evaluated.filter((t) => first(t).pass).length, evaluated.length),
    passAtR: rate(evaluated.filter((t) => t.pass).length, evaluated.length),
    recovery: {
      ...rate(recovered, attempted.length),
      notAttempted: initialFailures.length - attempted.length,
      executedTrials: recoveryExecutions.length,
      executedRecoveries,
      costPerRecoveryUsd: recoveryCost("costUsd"),
      costEquivPerRecoveryUsd: recoveryCost("costEquivUsd"),
    },
    byComplexity: ["trivial", "small", "medium"].map((complexity) => {
      const group = evaluated.filter((t) => t.details.complexity === complexity);
      const passes = group.filter((t) => t.pass).length;
      return {
        complexity,
        passes,
        evaluatedTrials: group.length,
        passRate: group.length ? passes / group.length : null,
        ci: wilson(passes, group.length),
      };
    }),
    failureReasons: Object.fromEntries(
      ["hidden_tests", "gates", "audit", "error", "timeout"].map((reason) => [
        reason,
        evaluated.filter((t) => !t.pass && (t.details.grade?.implement?.reason ?? "error") === reason).length,
      ]),
    ),
    costPerTrialUsd: mean(executed.map((t) => t.costUsd)),
    costEquivPerTrialUsd: mean(executed.map((t) => t.costEquivUsd)),
    executedTrials: executed.length,
  };
}
export function summarize(run: EvalRun, trials: EvalTrial[], options: StatsOptions = {}) {
  const settings = statsOptions(options);
  const targets = [
    ...new Set([
      ...trials.map(evidenceTarget),
      ...run.models.filter((id) => !trials.some((t) => recordedTarget(t) === id)),
    ]),
  ];
  const summaries = targets.map((modelId) => {
    const rows = trials.filter((t) => evidenceTarget(t) === modelId);
    const evaluated = rows.filter((t) => t.pass !== null && ["ok", "error"].includes(t.status));
    const passes = evaluated.filter((t) => t.pass).length;
    const risk = rows.flatMap((t) =>
      typeof t.details.grade?.riskUnderCall === "boolean" ? [Number(t.details.grade.riskUnderCall)] : [],
    );
    const complete = completeCases(rows, run.k);
    const flips = [...complete.values()].filter((g) => new Set(g.map((t) => t.pass)).size > 1).length;
    const latency = rows
      .filter(
        (t) =>
          !t.details.cache &&
          !t.details.interrupted &&
          !t.details.preparationFailed &&
          ["ok", "error"].includes(t.status),
      )
      .map((t) => t.durationMs)
      .sort((a, b) => a - b);
    const middle = Math.floor(latency.length / 2);
    return {
      modelId,
      effort: rows[0]?.effort ?? null,
      ...roleMetrics(run, rows),
      ...(run.role === "implement"
        ? {
            implement: {
              strategy: run.strategy ?? "retry",
              rounds: run.rounds ?? 1,
              ...implementMetrics(rows),
            },
          }
        : {}),
      cases: new Set(evaluated.map((t) => t.caseId)).size,
      evaluatedTrials: evaluated.length,
      skipped: rows.filter((t) => t.status === "skipped").length,
      errors: rows.filter((t) => t.status === "error").length,
      cached: rows.filter((t) => t.details.cache).length,
      pending: rows.filter((t) => t.status === "queued" || t.status === "running").length,
      unscored: rows.filter((t) => t.status === "ok" && t.pass === null).length,
      passes,
      passRate: evaluated.length ? passes / evaluated.length : null,
      ci: wilson(passes, evaluated.length),
      meanScore: mean(evaluated.map((t) => t.score ?? 0)),
      riskUnderCallRate: mean(risk),
      riskDenominator: risk.length,
      flipRate: run.k > 1 && complete.size ? flips / complete.size : null,
      flipDenominator: run.k > 1 ? complete.size : 0,
      costUsd: rows.reduce((n, t) => n + t.costUsd, 0),
      costEquivUsd: rows.reduce((n, t) => n + t.costEquivUsd, 0),
      p50LatencyMs: !latency.length
        ? null
        : latency.length % 2
          ? (latency[middle] ?? null)
          : ((latency[middle - 1] ?? 0) + (latency[middle] ?? 0)) / 2,
      latencyDenominator: latency.length,
    };
  });
  const best = [...summaries]
    .filter((m) => m.passRate !== null)
    .sort(
      (a, b) =>
        (b.passRate ?? 0) - (a.passRate ?? 0) || (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0),
    )[0];
  const bestCases = completeCases(
    trials.filter((t) => evidenceTarget(t) === best?.modelId),
    run.k,
  );
  return summaries.map((summary) => {
    const candidate = completeCases(
      trials.filter((t) => evidenceTarget(t) === summary.modelId),
      run.k,
    );
    const differences: number[] = [];
    for (const [id, group] of candidate) {
      const baseline = bestCases.get(id);
      if (baseline)
        differences.push(
          (mean(group.map((t) => Number(t.pass))) ?? 0) - (mean(baseline.map((t) => Number(t.pass))) ?? 0),
        );
    }
    return {
      ...summary,
      comparison: {
        bestModel: best?.modelId ?? null,
        candidateCompleteCases: candidate.size,
        bestCompleteCases: bestCases.size,
        ...pairedBootstrap(differences, settings),
      },
    };
  });
}
export interface EvalReport {
  run: EvalRun;
  summaries: ReturnType<typeof summarize>;
  trials: EvalTrial[];
}
