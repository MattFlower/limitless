import type { Effort, EvalRun, EvalTrial } from "../core/types.ts";
import type { ModelDef, Policy, ProviderDef } from "../router/catalog.ts";
import type { PolicyOverlay } from "../router/policy.ts";
import { effortTransportError, evidenceTarget, parseTarget, recordedTarget } from "../router/targets.ts";
import type { EvalSettings } from "./settings.ts";
import { completeCases, pairedBootstrap, summarize, wilson } from "./stats.ts";

export const EVAL_ROLES = ["triage", "review", "verify"] as const;
export interface Evidence {
  run: EvalRun;
  trials: EvalTrial[];
}
export interface PolicyInput {
  evidence: Evidence[];
  models: ModelDef[];
  providers: ProviderDef[];
  settings: EvalSettings;
  evalIds?: string[];
}
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Newest completed evidence independently for each role/model; explicit IDs are fail-closed. */
export function selectEvidence(evidence: Evidence[], ids?: string[]) {
  if (ids !== undefined) {
    if (!ids.length || ids.some((id) => !id.trim())) throw new Error("--evals requires nonempty eval IDs");
    for (const id of ids) {
      const entry = evidence.find((e) => e.run.id === id);
      if (!entry) throw new Error(`Unknown eval ID: ${id}`);
      if (entry.run.status !== "completed") throw new Error(`Eval ${id} is not completed`);
    }
  }
  const selected = new Map<string, Evidence & { modelId: string }>();
  const ordered = evidence
    .filter((e) => e.run.status === "completed" && (!ids || ids.includes(e.run.id)))
    .sort(
      (a, b) =>
        (b.run.finishedAt ?? -Infinity) - (a.run.finishedAt ?? -Infinity) ||
        b.run.createdAt - a.run.createdAt ||
        compareId(b.run.id, a.run.id),
    );
  for (const entry of ordered)
    for (const modelId of [
      ...new Set([
        ...entry.trials.map(evidenceTarget),
        ...entry.run.models.filter((id) => !entry.trials.some((t) => recordedTarget(t) === id)),
      ]),
    ]) {
      const key = `${entry.run.role}:${modelId}`;
      if (!selected.has(key)) selected.set(key, { ...entry, modelId });
    }
  return [...selected.values()].sort(
    (a, b) => compareId(a.run.role, b.run.role) || compareId(a.modelId, b.modelId),
  );
}
/**
 * Floors ("lower") require the Wilson 95% lower bound; ceilings ("upper") require the Wilson 95%
 * upper bound. When a dataset is too small to establish a ceiling even with zero errors (e.g. a 0.10
 * ceiling needs 35+ error-free observations), the metric is "insufficient evidence", not a failure:
 * routing stays unchanged until more cases exist, and default ceilings are sized to the datasets.
 */
function metric(
  name: string,
  numerator: number,
  denominator: number,
  direction: "lower" | "upper",
  floor: number,
) {
  const rate = denominator ? numerator / denominator : null;
  const ci = wilson(numerator, denominator);
  const reason =
    rate === null || !ci
      ? `insufficient evidence: ${name} has no observations`
      : direction === "lower"
        ? ci[0] < floor
          ? `${name} lower bound ${ci[0].toFixed(4)} is below floor ${floor}`
          : null
        : (wilson(0, denominator)?.[1] ?? 1) > floor
          ? `insufficient evidence: ${denominator} observations cannot establish ${name} ≤ ${floor}`
          : ci[1] > floor
            ? `${name} upper bound ${ci[1].toFixed(4)} exceeds ceiling ${floor}`
            : null;
  return { name, numerator, denominator, rate, ci, direction, floor, reason };
}
export function generatePolicy(input: PolicyInput) {
  const { models, providers, settings } = input;
  const selected = selectEvidence(input.evidence, input.evalIds);
  const roles = EVAL_ROLES.map((role) => {
    const entries = selected
      .filter((e) => e.run.role === role)
      .map((entry) => {
        const rows = entry.trials.filter((t) => evidenceTarget(t) === entry.modelId);
        const summary = summarize({ ...entry.run, models: [entry.modelId] }, rows)[0];
        if (!summary) throw new Error("Missing model summary");
        const baseId = rows[0]?.modelId ?? parseTarget(entry.modelId).modelId;
        const model = models.find((m) => m.id === baseId);
        const provider = providers.find((p) => p.id === model?.provider);
        const excluded =
          model &&
          settings.excludeOrigins !== undefined &&
          (settings.excludeOrigins.includes(model.origin) ||
            settings.excludeOrigins.includes(model.baseOrigin) ||
            model.baseOrigin === "unknown");
        const reasons: string[] = [];
        if (!model || !provider) reasons.push("catalog/provider metadata unavailable");
        if (excluded) reasons.push(`origin excluded (${model?.origin}; baseOrigin=${model?.baseOrigin})`);
        // Without trials only the saved reference exists, and metrics already mark it insufficient.
        const recordedEffort = rows.length
          ? (rows[0]?.effort ?? null)
          : ((parseTarget(entry.modelId).effort as Effort | undefined) ?? "default");
        const effortProblem =
          recordedEffort === null
            ? "legacy evidence with unknown effort"
            : recordedEffort === "default"
              ? model?.effort !== undefined
                ? `recorded with backend-default effort, but ${model.id} now defaults to ${model.effort}`
                : null
              : !model || !model.supportedEfforts.includes(recordedEffort)
                ? `unsupported recorded effort ${recordedEffort}`
                : effortTransportError(
                    role,
                    { model, effort: recordedEffort, targetId: entry.modelId },
                    provider,
                  );
        if (effortProblem) reasons.push(effortProblem);
        const referenceAllowed = Boolean(model && provider && !excluded && !effortProblem);
        const f = settings.floors;
        const passMetric = metric(
          "pass rate",
          summary.passes,
          summary.evaluatedTrials,
          "lower",
          f.triage_pass_rate,
        );
        const metrics =
          role === "triage"
            ? [
                passMetric,
                metric(
                  "risk under-call",
                  rows.filter((t) => t.details.grade?.riskUnderCall === true).length,
                  summary.riskDenominator,
                  "upper",
                  f.triage_risk_under_call_rate,
                ),
              ]
            : role === "review"
              ? [
                  metric(
                    "defect recall",
                    summary.review?.defectRecall.numerator ?? 0,
                    summary.review?.defectRecall.denominator ?? 0,
                    "lower",
                    f.review_defect_recall,
                  ),
                  metric(
                    "clean false-block",
                    summary.review?.falseBlock.numerator ?? 0,
                    summary.review?.falseBlock.denominator ?? 0,
                    "upper",
                    f.review_clean_false_block_rate,
                  ),
                ]
              : [
                  metric(
                    "false-accept",
                    summary.verify?.falseAccept.numerator ?? 0,
                    summary.verify?.falseAccept.denominator ?? 0,
                    "upper",
                    f.verify_false_accept_rate,
                  ),
                ];
        for (const m of metrics) if (m.reason) reasons.push(m.reason);
        const attempts = rows.filter(
          (t) => ["ok", "error"].includes(t.status) && !t.details.preparationFailed,
        );
        const costs = attempts.map((t) => {
          if (provider?.billing === "free") return 0;
          const source = t.details.cache ?? t;
          const value =
            provider?.billing === "metered"
              ? source.costUsd
              : source.costEquivUsd * settings.subscription_weight;
          return Number.isFinite(value) && value >= 0 ? value : null;
        });
        const costPerCase =
          !provider || !attempts.length || costs.includes(null)
            ? null
            : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0) / attempts.length;
        if (provider && !attempts.length) reasons.push("insufficient evidence: no attempted cases to cost");
        else if (costPerCase === null) reasons.push("applicable cost estimate unavailable");
        return {
          modelId: entry.modelId,
          run: entry.run,
          summary,
          passMetric,
          metrics,
          reasons,
          referenceAllowed,
          costPerCase,
          costDenominator: attempts.length,
          billing: provider?.billing ?? null,
          complete: completeCases(rows, entry.run.k),
        };
      });
    const best = [...entries]
      .filter((e) => e.referenceAllowed && e.summary.passRate !== null)
      .sort(
        (a, b) => (b.summary.passRate ?? 0) - (a.summary.passRate ?? 0) || compareId(a.modelId, b.modelId),
      )[0];
    const candidates = entries.map(({ complete, referenceAllowed, ...entry }) => {
      const differences: number[] = [];
      const mean = (rows: EvalTrial[]) => rows.reduce((n, t) => n + Number(t.pass), 0) / rows.length;
      for (const [id, rows] of [...complete].sort(([a], [b]) => compareId(a, b))) {
        const baseline = best?.complete.get(id);
        if (baseline) differences.push(mean(rows) - mean(baseline));
      }
      const comparison = {
        bestModel: best?.modelId ?? null,
        candidateCompleteCases: complete.size,
        bestCompleteCases: best?.complete.size ?? 0,
        ...pairedBootstrap(differences, { delta: settings.delta }),
      };
      // Only metadata-less or origin-excluded candidates are barred from being the reference; when
      // every candidate is barred there is no reference, and that says nothing about paired coverage.
      if (comparison.nonInferior === null) {
        if (referenceAllowed || best) entry.reasons.push("insufficient evidence: no complete paired cases");
      } else if (!comparison.nonInferior) entry.reasons.push("non-inferiority not established");
      // Hard rejections are decisive: more evidence could not make the candidate eligible.
      const state =
        entry.reasons.length === 0
          ? "eligible"
          : entry.reasons.every((r) => r.startsWith("insufficient evidence"))
            ? "insufficient evidence"
            : "ineligible";
      return {
        ...entry,
        summary: { ...entry.summary, comparison },
        comparison,
        state,
        eligible: state === "eligible",
      };
    });
    const order = candidates
      .filter((c) => c.eligible)
      .sort(
        (a, b) =>
          (a.costPerCase ?? Infinity) - (b.costPerCase ?? Infinity) ||
          (a.summary.p50LatencyMs ?? Infinity) - (b.summary.p50LatencyMs ?? Infinity) ||
          compareId(a.modelId, b.modelId),
      )
      .map((c) => c.modelId);
    // Availability: eligible candidates often share a provider, so one outage takes the whole cell
    // down. For each provider the chain doesn't use yet, append its cheapest candidate that clears
    // every floor and ceiling and fails only non-inferiority — worse beats no capacity.
    const providerOf = (id: string) => models.find((m) => m.id === id.split("@")[0])?.provider ?? null;
    const covered = new Set(order.map(providerOf));
    const availability: string[] = [];
    if (order.length)
      for (const c of candidates
        .filter(
          (c) =>
            !c.eligible &&
            c.reasons.length > 0 &&
            c.reasons.every((r) => r === "non-inferiority not established"),
        )
        .sort(
          (a, b) =>
            (a.costPerCase ?? Infinity) - (b.costPerCase ?? Infinity) ||
            (a.summary.p50LatencyMs ?? Infinity) - (b.summary.p50LatencyMs ?? Infinity) ||
            compareId(a.modelId, b.modelId),
        )) {
        const provider = providerOf(c.modelId);
        if (covered.has(provider)) continue;
        covered.add(provider);
        availability.push(c.modelId);
      }
    order.push(...availability);
    return {
      role,
      candidates,
      order,
      availabilityFallbacks: availability,
      decision: order.length
        ? `Update ${role}.default: ${order.join(" → ")}${availability.length ? ` (availability fallbacks on other providers, clearing every floor but not non-inferior: ${availability.join(", ")})` : ""}`
        : candidates.length
          ? `${role} unchanged: no eligible models (${candidates.map((c) => `${c.modelId}: ${c.reasons.join("; ")}`).join(" | ")})`
          : `${role} unchanged: no completed evidence`,
    };
  });
  const generated: PolicyOverlay = {};
  for (const r of roles) if (r.order.length) generated[r.role] = { default: r.order };
  return { roles, generated, settings };
}
export type PolicyEvaluation = ReturnType<typeof generatePolicy>;
export interface EvalPolicyResponse {
  evaluation: PolicyEvaluation;
  models: ModelDef[];
  /** Absent from older daemons; validation then falls back to the built-in providers. */
  providers?: ProviderDef[];
  policy: Policy;
  runs: (EvalRun & { costUsd: number; costEquivUsd: number })[];
}
