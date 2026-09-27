import type { EvalRun, EvalTrial } from "../src/core/types.ts";
import { type Evidence, generatePolicy, type PolicyInput } from "../src/evals/policy.ts";
import { evalSettings } from "../src/evals/settings.ts";
import { DEFAULT_POLICY, MODELS, PROVIDERS } from "../src/router/catalog.ts";

export const local = "mtplx/qwen-27b";
export const subscription = "codex/luna";
export const metered = "openrouter/gpt-6-luna";
export function evidence(
  role: EvalRun["role"] = "triage",
  models = [local],
  options: Partial<EvalRun> = {},
): Evidence {
  const run: EvalRun = {
    id: `${role}-run`,
    role,
    models,
    k: 1,
    status: "completed",
    createdAt: 1000,
    finishedAt: 2000,
    maxUsd: 10,
    error: null,
    ...options,
  };
  const trials: EvalTrial[] = run.models.flatMap((modelId) =>
    Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: run.k }, (_, trial) => ({
        evalRunId: run.id,
        caseId: `case-${String(i).padStart(2, "0")}`,
        modelId,
        trial,
        cacheKey: "key",
        harness: "fake",
        status: "ok" as const,
        output: {},
        pass: true,
        score: 1,
        details: {
          grade: {
            pass: true,
            score: 1,
            fields: {},
            riskUnderCall: role === "triage" ? false : null,
            ...(role === "review"
              ? {
                  review: {
                    requiredMatched: i < 20 ? 1 : 0,
                    requiredTotal: i < 20 ? 1 : 0,
                    recall: i < 20 ? 1 : null,
                    requestChanges: i < 20,
                    falseBlock: i < 20 ? null : false,
                    verdictMatch: true,
                  },
                }
              : {}),
            ...(role === "verify"
              ? {
                  verify: {
                    matched: 1,
                    total: 1,
                    falseAccepts: 0,
                    unmetTotal: 1,
                    falseRejects: 0,
                    metTotal: 0,
                    criteria: {},
                  },
                }
              : {}),
          },
        },
        costUsd: 0.4,
        costEquivUsd: 1,
        tokensIn: 1,
        tokensOut: 1,
        durationMs: 100,
        createdAt: 1000,
      })),
    ).flat(),
  );
  return { run, trials };
}
export function input(rows: Evidence[] = [evidence()], options: Partial<PolicyInput> = {}): PolicyInput {
  return { evidence: rows, models: MODELS, providers: PROVIDERS, settings: evalSettings({}), ...options };
}
export function response(rows: Evidence[] = [evidence()], options: Partial<PolicyInput> = {}) {
  const data = input(rows, options);
  return {
    evaluation: generatePolicy(data),
    models: data.models,
    policy: DEFAULT_POLICY,
    runs: rows.map(({ run, trials }) => ({
      ...run,
      costUsd: trials.reduce((s, t) => s + t.costUsd, 0),
      costEquivUsd: trials.reduce((s, t) => s + t.costEquivUsd, 0),
    })),
  };
}
