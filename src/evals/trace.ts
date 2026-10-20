import registration from "../../evals/review/trace-experiment.json";
import type { EvalTrial } from "../core/types.ts";
import { blockingReviewFindings } from "../pipeline/review.ts";
import { StoredReviewSchema } from "../pipeline/schemas.ts";
import { recordedTarget } from "../router/targets.ts";
import type { ReviewCase } from "./cases.ts";
import { gradeReview, matchedReviewDefects } from "./graders/review.ts";
import { type EvalReport, summarize } from "./stats.ts";

/** Regrade paired outputs against one label set; incomplete evidence never passes registration. */
export function compareTrace(cases: ReviewCase[], baseline: EvalTrial[], variant: EvalTrial[], k = 2) {
  const rate = (caught: number, total: number) => ({ caught, total, rate: total ? caught / total : null });
  const categories = [...new Set(cases.flatMap((c) => c.defects.map((d) => d.category)))];
  const arm = () => ({
    caught: 0,
    total: 0,
    cleanBlocked: 0,
    cleanTrials: 0,
    findings: 0,
    categories: Object.fromEntries(categories.map((c) => [c, { caught: 0, total: 0 }])),
    union: new Set<string>(),
  });
  const arms = [arm(), arm()];
  const missing: string[] = [];
  const trace = { added: 0, addedOnGold: 0, cleanBlocked: 0, newlyBlocked: 0, cleanTrials: 0 };
  for (const item of cases)
    for (let trial = 0; trial < k; trial++) {
      const rows = [baseline, variant].map((rows) =>
        rows.filter((t) => t.caseId === item.id && t.trial === trial),
      );
      const outputs = rows.map((r) =>
        r.length === 1 && r[0]?.status === "ok" ? StoredReviewSchema.safeParse(r[0].output) : undefined,
      );
      const b = outputs[0];
      const v = outputs[1];
      const panel = v?.success ? v.data.panel : undefined;
      const mainReport = panel?.reports?.[0];
      if (
        !b?.success ||
        !v?.success ||
        panel?.finders?.length !== 2 ||
        panel.finders[0]?.prompt !== "standard" ||
        panel.finders[1]?.prompt !== "trace" ||
        panel.reports?.length !== 2 ||
        !mainReport ||
        panel.candidates.some((c) => !c.raisedBy?.length)
      ) {
        missing.push(`${item.id}/${trial}`);
        continue;
      }
      for (const [i, output] of [b.data, v.data].entries()) {
        const a = arms[i];
        if (!a) continue;
        const blocking = blockingReviewFindings(output);
        const { required, caught } = matchedReviewDefects(item, blocking);
        a.caught += caught.size;
        a.total += required.length;
        a.findings += output.findings.length;
        for (const [d, defect] of required.entries()) {
          const group = a.categories[defect.category];
          if (!group) continue;
          group.total++;
          if (caught.has(d)) {
            group.caught++;
            a.union.add(`${item.id}/${d}`);
          }
        }
        if (item.kind === "clean") {
          a.cleanTrials++;
          a.cleanBlocked += Number(blocking.length > 0);
        }
      }
      const added = panel.candidates.filter((c) => c.raisedBy?.includes(1) && !c.raisedBy.includes(0));
      trace.added += added.length;
      const { required, caught } = matchedReviewDefects(item, mainReport.findings);
      const remaining = { ...item, defects: required.filter((_, i) => !caught.has(i)) };
      trace.addedOnGold += matchedReviewDefects(remaining, added).caught.size;
      if (item.kind === "clean") {
        trace.cleanTrials++;
        const blocked = panel.reports[1] && blockingReviewFindings(panel.reports[1]).length > 0;
        const mainBlocked = panel.reports[0] && blockingReviewFindings(panel.reports[0]).length > 0;
        trace.cleanBlocked += Number(blocked);
        trace.newlyBlocked += Number(blocked && !mainBlocked);
      }
    }
  const [b, v] = arms;
  if (!b || !v) throw new Error("Missing comparison arms");
  const improvement = b.total ? (v.caught - b.caught) / b.total : null;
  const additionalCleanBlocks = v.cleanBlocked - b.cleanBlocked;
  return {
    expectedPairs: cases.length * k,
    pairedTrials: cases.length * k - missing.length,
    missing,
    arms: arms.map((a) => ({
      pooled: rate(a.caught, a.total),
      cleanBlocks: rate(a.cleanBlocked, a.cleanTrials),
      findings: a.findings,
      byCategory: Object.fromEntries(
        Object.entries(a.categories).map(([c, g]) => [c, rate(g.caught, g.total)]),
      ),
      repetitionUnion: rate(
        a.union.size,
        cases.reduce((n, c) => n + c.defects.filter((d) => d.required).length, 0),
      ),
    })),
    trace,
    improvement,
    additionalCleanBlocks,
    decision: {
      minimumRecallGain: 0.08,
      maximumAdditionalCleanBlocks: 1,
      pass:
        missing.length === 0 &&
        b.cleanTrials > 0 &&
        improvement !== null &&
        (v.caught - b.caught) * 100 >= 8 * b.total &&
        additionalCleanBlocks <= 1,
    },
  };
}

/** Registered offline experiment; rejects alternate baselines/configurations before comparing. */
export function traceExperimentReport(baseline: EvalReport, variant: EvalReport, allCases: ReviewCase[]) {
  if (baseline.run.id !== registration.baseline) throw new Error("Expected the registered E1 baseline");
  const cases = allCases.filter((c) => registration.caseIds.includes(c.id));
  if (cases.length !== registration.caseIds.length) throw new Error("Missing registered cases");
  const reports = [baseline, variant].map((report, index) => {
    if (report.run.role !== "review" || report.run.k !== registration.k || report.run.status !== "completed")
      throw new Error("Expected completed k=2 review evidence");
    const system = report.run.systems?.find(
      (s) =>
        s.mode === "single" &&
        !s.setup &&
        !s.verifier &&
        s.implementerReport === "include" &&
        s.finders.length === (index ? 2 : 1) &&
        s.finders.every(
          (f, i) => f.target === registration.target && f.prompt === (i ? "trace" : "standard"),
        ) &&
        (!index || s.name === registration.variant),
    );
    if ((report.run.systems && !system) || (index && !system))
      throw new Error("Wrong prompt, targets or implementer report");
    const trials = report.trials
      .filter(
        (t) =>
          recordedTarget(t) === registration.target &&
          (!system || t.details.system === system.name) &&
          registration.caseIds.includes(t.caseId),
      )
      .map((t) => {
        const item = cases.find((c) => c.id === t.caseId);
        if (!item) throw new Error("Missing case labels");
        const output = StoredReviewSchema.safeParse(t.output);
        const grade = t.status === "ok" && output.success ? gradeReview(item, output.data) : undefined;
        return grade ? { ...t, pass: grade.pass, score: grade.score, details: { ...t.details, grade } } : t;
      });
    return {
      run: { ...report.run, models: [registration.target], systems: system ? [system] : undefined },
      trials,
    };
  });
  const [b, v] = reports;
  if (!b || !v) throw new Error("Missing reports");
  return {
    registration,
    labels: "current evals/review/cases.json (both arms regraded)",
    comparison: compareTrace(cases, b.trials, v.trials, registration.k),
    measures: reports.map((r) => ({
      summaries: summarize(r.run, r.trials),
      tokensOut: r.trials.reduce((n, t) => n + t.tokensOut, 0),
    })),
  };
}
