import type { EvalPolicyResponse } from "../../src/evals/policy.ts";

/** The daemon owns statistical decisions; the UI only arranges cells and links. */
export function evalMatrix(data: EvalPolicyResponse) {
  const models = [
    ...new Set([
      ...data.models.map((m) => m.id),
      ...data.evaluation.roles.flatMap((r) => r.candidates.map((c) => c.modelId)),
    ]),
  ].sort();
  return {
    models,
    rows: data.evaluation.roles.map((r) => ({
      role: r.role,
      cells: models.map((modelId) => {
        const candidate = r.candidates.find((c) => c.modelId === modelId);
        return {
          modelId,
          state: candidate?.state ?? "no result",
          reasons: candidate?.reasons ?? [],
          href: candidate ? `/evals/${encodeURIComponent(candidate.run.id)}` : null,
          candidate,
        };
      }),
    })),
  };
}
