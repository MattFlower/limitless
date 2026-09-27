import type { EvalReport } from "./stats.ts";
import { wilson } from "./stats.ts";

export function formatEvalReport(report: EvalReport): string {
  const number = (n: number | null) => (n === null ? "n/a" : n.toFixed(3));
  const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
  const lines = [
    `${report.run.id}: ${report.run.status} (role=${report.run.role}, k=${report.run.k}, maxUsd=${report.run.maxUsd})`,
  ];
  if (report.run.error) lines.push(report.run.error);
  for (const m of report.summaries) {
    const c = m.comparison;
    const metric = (name: string, value: { numerator: number; denominator: number; rate: number | null }) =>
      `  ${name} ${pct(value.rate)} (${value.numerator}/${value.denominator}), Wilson 95% CI ${wilson(value.numerator, value.denominator)?.map(pct).join(" – ") ?? "n/a"}`;
    const roleLines: string[] = [];
    if (m.review) {
      const { defectRecall, falseBlock, verdictAccuracy } = m.review;
      roleLines.push(
        metric("defect recall", defectRecall),
        metric("clean false-block", falseBlock),
        metric("verdict accuracy", verdictAccuracy),
      );
    }
    if (m.verify)
      roleLines.push(
        metric("false-accept", m.verify.falseAccept),
        metric("false-reject", m.verify.falseReject),
        metric("criterion accuracy", m.verify.criterionAccuracy),
      );
    lines.push(
      `${m.modelId}: ${m.cases} cases, ${m.evaluatedTrials} evaluated trials; skipped=${m.skipped}, errors=${m.errors}, cached=${m.cached}, pending=${m.pending}, unscored=${m.unscored}`,
      `  pass ${pct(m.passRate)} (${m.passes}/${m.evaluatedTrials}), Wilson 95% CI ${m.ci ? `[${pct(m.ci[0])}, ${pct(m.ci[1])}]` : "n/a"}; mean score ${number(m.meanScore)}`,
      ...roleLines,
      `  prediction coverage ${m.predictionTrials}/${m.scheduledTrials} (${pct(m.predictionCoverage)}); flip ${pct(m.flipRate)} (n=${m.flipDenominator})`,
      ...(report.run.role === "triage"
        ? [
            metric("risk under-call", {
              rate: m.riskUnderCallRate,
              numerator: Math.round((m.riskUnderCallRate ?? 0) * m.riskDenominator),
              denominator: m.riskDenominator,
            }),
          ]
        : []),
      `  metered $${m.costUsd.toFixed(4)}; API-equivalent $${m.costEquivUsd.toFixed(4)}; p50 invocation ${number(m.p50LatencyMs)} ms (n=${m.latencyDenominator})`,
      `  vs ${c.bestModel ?? "n/a"}: difference ${number(c.meanDifference)}, one-sided 95% lower ${number(c.lowerBound)}, nonInferior=${c.nonInferior ?? "n/a"}; paired cases=${c.pairedCases} (candidate complete=${c.candidateCompleteCases}, best complete=${c.bestCompleteCases}), delta=${c.delta}, resamples=${c.resamples}, seed=${c.seed}`,
    );
  }
  return lines.join("\n");
}
