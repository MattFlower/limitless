import type { EvalPolicyResponse } from "../../src/evals/policy.ts";

/** The daemon owns statistical decisions; the UI only arranges cells and links. */
export function evalMatrix(data: EvalPolicyResponse) {
  const models = [
    ...new Set([
      ...(data.implement ?? []).map((e) => e.summary.modelId),
      ...data.models.map((m) => m.id),
      ...data.evaluation.roles.flatMap((r) => r.candidates.map((c) => c.modelId)),
    ]),
  ].sort();
  return {
    models,
    rows: [
      ...data.evaluation.roles.map((r) => ({
        role: r.cell === "default" ? r.role : `${r.role}.${r.cell}`,
        decision: r.role === "implement" ? r.decision : null,
        cells: models.map((modelId) => {
          const candidate = r.candidates.find((c) => c.modelId === modelId);
          return {
            modelId,
            state: candidate?.state ?? "no result",
            reasons: candidate?.reasons ?? [],
            href: candidate ? `/evals/${encodeURIComponent(candidate.run.id)}` : null,
            candidate,
            costPerCase: candidate?.costPerCase ?? null,
            comparison: candidate?.comparison ?? null,
            availabilityFallback: r.availabilityFallbacks.includes(modelId),
          };
        }),
      })),
      {
        role: "implement",
        decision: null,
        cells: models.map((modelId) => {
          const result = data.implement?.find((e) => e.summary.modelId === modelId);
          return {
            modelId,
            state: result ? "evaluated" : "no result",
            reasons: [],
            href: result ? `/evals/${encodeURIComponent(result.run.id)}` : null,
            costPerCase: null,
            comparison: null,
            availabilityFallback: false,
            candidate: result
              ? {
                  summary: result.summary,
                  metrics: [
                    {
                      name: "pass rate",
                      rate: result.summary.passRate,
                      numerator: result.summary.passes,
                      denominator: result.summary.evaluatedTrials,
                      ci: result.summary.ci,
                    },
                  ],
                }
              : undefined,
          };
        }),
      },
    ],
  };
}
