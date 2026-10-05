import { cacheHitRate } from "../core/cache-format.ts";
import { effortLabel } from "../core/effort-format.ts";
import type { EvalReport } from "./stats.ts";
import { wilson } from "./stats.ts";

type Escalation = NonNullable<EvalReport["summaries"][number]["escalation"]>;
const percent = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");

function escalationLines(e: Escalation): string[] {
  const threshold = e.thresholds.length ? ` at decision_confidence ${e.thresholds.join(", ")}` : "";
  const c = e.cascade;
  return [
    `  escalated to the next triage model: ${e.escalated}/${e.trials} (${percent(e.escalated, e.trials)}): declined ${e.declined}${threshold}, failed ${e.failed}`,
    !c
      ? "  cascade: n/a (no non-decision triage model in the routing policy)"
      : c.passes === null
        ? `  cascade via ${c.fallbackModel}: n/a (no trials for it in this eval)`
        : `  cascade via ${c.fallbackModel}: pass ${percent(c.passes, e.trials)} (${c.passes}/${e.trials})${c.missing ? `, ${c.missing} escalated without a fallback trial` : ""}; per request $${c.costPerTrialUsd?.toFixed(6) ?? "n/a"}, ${c.latencyPerTrialMs?.toFixed(0) ?? "n/a"} ms`,
  ];
}

export function formatEvalReport(report: EvalReport): string {
  const number = (n: number | null) => (n === null ? "n/a" : n.toFixed(3));
  const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
  const lines = [
    `${report.run.id}: ${report.run.status} (role=${report.run.role}, k=${report.run.k}, maxUsd=${report.run.maxUsd}, concurrency=${report.run.concurrency ?? "1 (legacy)"})`,
  ];
  if (report.run.error) lines.push(report.run.error);
  if (report.run.resumedFrom) {
    const copied = report.trials.filter((t) => t.details.resumedFrom).length;
    lines.push(
      `resumed from ${report.run.resumedFrom}: ${copied} trials copied, ${report.trials.length - copied} run again`,
    );
  }
  if (report.run.resumedBy) lines.push(`resumed by ${report.run.resumedBy}`);
  for (const m of report.summaries) {
    const c = m.comparison;
    if (m.system?.replayFrom) lines.push(`${m.candidate}: replayed finders from ${m.system.replayFrom}`);
    const metric = (name: string, value: { numerator: number; denominator: number; rate: number | null }) =>
      `  ${name} ${pct(value.rate)} (${value.numerator}/${value.denominator}), Wilson 95% CI ${wilson(value.numerator, value.denominator)?.map(pct).join(" – ") ?? "n/a"}`;
    const roleLines: string[] = [];
    if (m.implement) {
      const { strategy, rounds, passAt1, passAtR, recovery } = m.implement;
      roleLines.push(metric("pass@1", passAt1));
      if (rounds > 1)
        roleLines.push(
          `  strategy=${strategy}, rounds=${rounds}`,
          metric(`pass@${rounds}`, passAtR),
          metric("recovery", recovery),
          `  recovery not attempted: ${recovery.notAttempted}`,
          `  incremental cost per recovery: metered $${number(recovery.costPerRecoveryUsd)}; API-equivalent $${number(recovery.costEquivPerRecoveryUsd)} (executed trials=${recovery.executedTrials}, recoveries=${recovery.executedRecoveries})`,
        );

      for (const group of m.implement.byComplexity)
        roleLines.push(
          metric(`${group.complexity} pass`, {
            numerator: group.passes,
            denominator: group.evaluatedTrials,
            rate: group.passRate,
          }),
        );
      roleLines.push(
        `  failures: ${Object.entries(m.implement.failureReasons)
          .map(([reason, count]) => `${reason}=${count}`)
          .join(", ")}`,
        `  cost per executed trial: metered $${number(m.implement.costPerTrialUsd)}; API-equivalent $${number(m.implement.costEquivPerTrialUsd)} (n=${m.implement.executedTrials})`,
      );
    }
    if (m.review) {
      const { defectRecall, underRated, falseBlock, verdictAccuracy, legacyGrades, originalLabels } =
        m.review;
      // A daemon older than blocking recall sends none of the breakdown, and its recall counted minor findings.
      const bySeverity = m.review.bySeverity ?? [];
      roleLines.push(
        metric(
          originalLabels
            ? "current labels: blocking recall"
            : underRated
              ? "blocking recall"
              : "defect recall (older daemon, not blocking recall)",
          defectRecall,
        ),
        ...bySeverity.map((group) => metric(`${group.severity}-severity blocking recall`, group)),
        ...(underRated
          ? [
              `  under-rated (detected, not blocking; diagnostic): ${underRated.numerator}/${underRated.denominator} required defects`,
            ]
          : []),
        metric(originalLabels ? "current labels: clean false-block" : "clean false-block", falseBlock),
        ...(originalLabels
          ? [
              metric("original labels: blocking recall", originalLabels.defectRecall),
              metric("original labels: clean false-block", originalLabels.falseBlock),
            ]
          : []),
        ...(m.review.cleanBlocking ?? []).map(
          (c) => `  clean ${c.caseId}: blocking findings per trial ${c.blockingFindings.join(", ")}`,
        ),
        metric("verdict accuracy", verdictAccuracy),
      );
      if (legacyGrades)
        roleLines.push(
          `  ${legacyGrades} trials graded before blocking recall are excluded from pass, recall and comparisons; \`limitless eval regrade ${report.run.id}\` recomputes them from stored output without model calls`,
        );
    }
    if (m.verify)
      roleLines.push(
        metric("false-accept", m.verify.falseAccept),
        metric("false-reject", m.verify.falseReject),
        metric("criterion accuracy", m.verify.criterionAccuracy),
      );
    lines.push(
      `${m.system ? `${m.candidate} [${m.modelId}, implementer report: ${m.system.implementerReport}]` : m.modelId} (effort: ${effortLabel(m.effort)}): ${m.cases} cases, ${m.evaluatedTrials} evaluated trials; skipped=${m.skipped}, errors=${m.errors}, cached=${m.cached}, pending=${m.pending}, unscored=${m.unscored}`,
      `  pass ${pct(m.passRate)} (${m.passes}/${m.evaluatedTrials}), Wilson 95% CI ${m.ci ? `[${pct(m.ci[0])}, ${pct(m.ci[1])}]` : "n/a"}; mean score ${number(m.meanScore)}`,
      ...roleLines,
      `  prediction coverage ${m.predictionTrials}/${m.scheduledTrials} (${pct(m.predictionCoverage)}); flip ${pct(m.flipRate)} (n=${m.flipDenominator})`,
      ...(m.escalation ? escalationLines(m.escalation) : []),
      ...(report.run.role === "triage"
        ? [
            metric("risk under-call", {
              rate: m.riskUnderCallRate,
              numerator: Math.round((m.riskUnderCallRate ?? 0) * m.riskDenominator),
              denominator: m.riskDenominator,
            }),
          ]
        : []),
      `  metered $${m.costUsd.toFixed(4)}; API-equivalent $${m.costEquivUsd.toFixed(4)}; p50 ${report.run.role === "implement" ? "trial" : "invocation"} ${number(m.p50LatencyMs)} ms (n=${m.latencyDenominator})`,
      `  cache ${cacheHitRate(m.cacheReadTokens, m.tokensIn)} of ${m.tokensIn.toLocaleString("en-US")} prompt tokens (${m.cacheReadTokens.toLocaleString("en-US")} cached, ${m.cacheWriteTokens.toLocaleString("en-US")} written, ${(m.tokensIn - m.cacheReadTokens - m.cacheWriteTokens).toLocaleString("en-US")} not cached)`,
      `  vs ${c.bestModel ?? "n/a"}: difference ${number(c.meanDifference)}, one-sided 95% lower ${number(c.lowerBound)}, nonInferior=${c.nonInferior ?? "n/a"}; paired cases=${c.pairedCases} (candidate complete=${c.candidateCompleteCases}, best complete=${c.bestCompleteCases}), delta=${c.delta}, resamples=${c.resamples}, seed=${c.seed}`,
    );
  }
  return lines.join("\n");
}
