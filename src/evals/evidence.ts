import type { Role } from "../core/types.ts";
import type { Policy } from "../router/catalog.ts";
import type { PolicyOverlay } from "../router/policy.ts";
import type { PolicyEvaluation } from "./policy.ts";
import { DEFAULT_STATS, wilson } from "./stats.ts";

const number = (n: number | null) => (n === null ? "n/a" : n.toFixed(4));
const escapeCell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
const date = (n: number | null) => (n === null ? "n/a" : new Date(n).toISOString());
export function renderEvidence(evaluation: PolicyEvaluation): string {
  const { settings } = evaluation;
  const lines = [
    "# Routing evidence",
    "",
    "Policy changes land through reviewed PRs; the diff is the approval. Deploy/restart to activate.",
    "",
    `Floors (inclusive; pass rate and defect recall use the Wilson 95% lower bound, error-rate ceilings use the Wilson 95% upper bound): ${JSON.stringify(settings.floors)}`,
    `Paired bootstrap: delta=${settings.delta}; seed=${DEFAULT_STATS.seed}; resamples=${DEFAULT_STATS.resamples}; one-sided 95% lower bound must be strictly > -delta.`,
    `Subscription weight=${settings.subscription_weight}; origin exclusions=${JSON.stringify(settings.excludeOrigins ?? null)} (when configured, unknown baseOrigin is excluded).`,
    "Cost/case averages case attempts over repetitions, including attempted failures, excluding skips and preparation failures. Local=0; metered=recorded dollars; subscription=API-equivalent dollars × weight. Cache replays use original cost provenance for estimates only; recorded spend stays unchanged.",
    "p50 invocation latency excludes cache replays, interrupted calls and preparation failures. Prediction metrics pool persisted labels; failures have no prediction observations. Missing observations are insufficient evidence.",
    "",
  ];
  for (const role of evaluation.roles) {
    lines.push(`## ${role.role}${role.cell === "default" ? "" : `.${role.cell}`}`, "", role.decision, "");
    if (role.role === "implement" && !role.escalation.length)
      lines.push("Effort-before-switch preference unchanged: no qualifying B1 paired recovery evidence.", "");
    if (!role.candidates.length) continue;
    lines.push(
      "| Model / source | Metrics: rate (numerator/denominator), Wilson 95% CI | Comparison | Cost/case | p50 latency | Eligibility / reasons |",
      "|---|---|---|---|---|---|",
    );
    for (const c of role.candidates) {
      const m = c.summary;
      const extra = [
        ...(m.review ? [{ name: "verdict accuracy", ...m.review.verdictAccuracy }] : []),
        ...(m.verify
          ? [
              { name: "false-reject", ...m.verify.falseReject },
              { name: "criterion accuracy", ...m.verify.criterionAccuracy },
            ]
          : []),
      ].map((v) => ({ ...v, ci: wilson(v.numerator, v.denominator) }));
      const metrics = [c.passMetric, ...c.metrics.filter((v) => v.name !== "pass rate"), ...extra]
        .map(
          (v) =>
            `${v.name}: ${number(v.rate)} (${v.numerator}/${v.denominator}), CI ${v.ci ? `[${v.ci.map(number).join(", ")}]` : "n/a"}`,
        )
        .join("; ");
      const cmp = c.comparison;
      lines.push(
        `| ${escapeCell(c.modelId)}; run=${escapeCell(c.run.id)}; created=${date(c.run.createdAt)}; finished=${date(c.run.finishedAt)}; k=${c.run.k} | ${metrics}; prediction coverage=${m.predictionTrials}/${m.scheduledTrials} (${number(m.predictionCoverage)}); errors=${m.errors}; skips=${m.skipped}; cached=${m.cached}; pending=${m.pending}; unscored=${m.unscored} | vs ${escapeCell(cmp.bestModel ?? "n/a")}; nonInferior=${cmp.nonInferior ?? "n/a"}; difference=${number(cmp.meanDifference)}; lower=${number(cmp.lowerBound)}; paired=${cmp.pairedCases}; complete candidate/reference=${cmp.candidateCompleteCases}/${cmp.bestCompleteCases} | ${number(c.costPerCase)} (${c.billing ?? "n/a"}; attempts=${c.costDenominator}); recorded metered=$${number(m.costUsd)}; API-equivalent=$${number(m.costEquivUsd)} | ${number(m.p50LatencyMs)} ms (n=${m.latencyDenominator}) | ${c.state}${c.reasons.length ? `: ${escapeCell(c.reasons.join("; "))}` : ""} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
/** Preserve unrelated and all-ineligible cells in the checkout document. */
export function proposedOverlay(existing: PolicyOverlay, evaluation: PolicyEvaluation): PolicyOverlay {
  const next = structuredClone(existing);
  for (const r of evaluation.roles)
    if (r.order.length) next[r.role] = { ...next[r.role], [r.cell]: [...r.order] };
  return next;
}
export function policyDiff(current: Policy, proposed: Policy, evaluation: PolicyEvaluation): string {
  const lines = ["--- current effective policy", "+++ proposed effective policy"];
  for (const role of Object.keys(current).sort() as Role[]) {
    const before = current[role];
    const after = proposed[role];
    for (const key of [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].sort() as (keyof typeof before)[]) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      lines.push(
        `@@ ${role}.${key} @@`,
        `- ${JSON.stringify(before[key]) ?? "(absent)"}`,
        `+ ${JSON.stringify(after[key]) ?? "(absent)"}`,
      );
    }
  }
  if (lines.length === 2) lines.push("No effective policy changes.");
  lines.push(...evaluation.roles.filter((r) => !r.order.length).map((r) => r.decision));
  return lines.join("\n");
}
