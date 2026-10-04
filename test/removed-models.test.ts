import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { formatEvalReport } from "../src/cli/eval.ts";
import { loadConfig } from "../src/config.ts";
import type { RunDetail } from "../src/core/types.ts";
import type { Stats } from "../src/db/stats.ts";
import type { EvalPolicyResponse } from "../src/evals/policy.ts";
import type { EvalReport } from "../src/evals/stats.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { DEFAULT_POLICY, MODELS, REMOVED_MODELS } from "../src/router/catalog.ts";
import { loadPolicy, validatePolicy } from "../src/router/policy.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { evalMatrix } from "../ui/lib/evals.ts";
import { evidence } from "./evals-policy-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

test("removed models are out of the catalog, and every built-in and committed chain resolves without them", () => {
  for (const id of REMOVED_MODELS.keys()) expect(MODELS.map((m) => m.id)).not.toContain(id);
  // The router skips unknown IDs in a chain silently, so a stale default would go unnoticed.
  expect(() => validatePolicy(DEFAULT_POLICY, MODELS)).not.toThrow();
  expect(() => loadPolicy(join(import.meta.dir, "../routing/policy.json"), MODELS)).not.toThrow();
});

test("stored history naming removed models renders through the API, run report, eval report and UI", async () => {
  const home = mkdtempSync(join(tmpdir(), "limitless-removed-models-"));
  const factory = new Factory(loadConfig({ home: join(home, "data"), configDir: join(home, "config") }));
  try {
    const { store } = factory;
    const repo = store.upsertRepo({
      slug: "test/repo",
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "legacy run" });
    const stage = store.startStage(run.id, "implement");
    for (const inv of [
      {
        role: "implement",
        harness: "codex",
        provider: "codex",
        model: "gpt-6-astra",
        modelId: "codex/astra",
      },
      {
        role: "review",
        harness: "claude",
        provider: "claude",
        model: "claude-fable-5-1",
        modelId: "claude/fable",
      },
    ] as const) {
      const row = store.createInvocation({ runId: run.id, stageId: stage.id, effort: "high", ...inv });
      store.updateInvocation(row.id, { status: "ok", costEquivUsd: 2, finishedAt: row.startedAt + 1000 });
    }
    store.refreshRunTotals(run.id);
    const routes = createHttpRoutes(factory);
    const call = async (route: string, params: Record<string, string> = {}, init: RequestInit = {}) => {
      const path = route.replace(/:(\w+)/g, (_, key: string) => params[key] ?? "");
      const handler = routes[route] as Route | { POST: Route };
      return (typeof handler === "function" ? handler : handler.POST)(
        requestWithParams(`http://localhost${path}`, init, params),
        localServer,
      );
    };
    const get = async <T>(route: string, params: Record<string, string> = {}) => {
      const response = await call(route, params);
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    };

    const detail = await get<RunDetail>("/api/runs/:id", { id: run.id });
    expect(detail.invocations.map((i) => i.modelId)).toEqual(["codex/astra", "claude/fable"]);
    const report = renderReport({
      success: true,
      runId: run.id,
      prompt: run.prompt,
      state: {},
      invocations: detail.invocations,
      totals: { costUsd: detail.run.costUsd, costEquivUsd: detail.run.costEquivUsd },
      runUrl: "u",
    });
    expect(report).toContain("| implement | `codex/astra` | high | ok |");
    expect(report).toContain("| review | `claude/fable` | high | ok |");
    const stats = await get<Stats>("/api/stats");
    expect(stats.models.map((m) => m.modelId)).toEqual(
      expect.arrayContaining(["codex/astra", "claude/fable"]),
    );

    const legacy = evidence("triage", ["codex/astra@high"]);
    const evalRun = store.createEvalRun(legacy.run, legacy.trials, {
      request: { role: "triage", models: ["codex/astra@high"], k: 1 },
    });
    store.updateEvalRun(evalRun.id, "completed");
    const evalReport = await get<EvalReport>("/api/evals/:id", { id: evalRun.id });
    expect(formatEvalReport(evalReport)).toContain("codex/astra@high");
    const policy = await get<EvalPolicyResponse>("/api/evals/policy");
    expect(policy.evaluation.roles.find((r) => r.role === "triage")?.candidates[0]).toMatchObject({
      modelId: "codex/astra@high",
      state: "ineligible",
      reasons: expect.arrayContaining(["codex/astra is not in the model catalog"]),
    });
    expect(policy.evaluation.generated).toEqual({});
    expect(evalMatrix(policy).models).toContain("codex/astra@high");

    // Resuming the eval re-validates its stored request, which names the removed model.
    store.updateEvalRun(evalRun.id, "interrupted");
    const resumed = await call(
      "/api/evals/:id/resume",
      { id: evalRun.id },
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    );
    expect(resumed.status).toBe(400);
    expect(await resumed.text()).toContain("GPT-6 Astra was removed from routing on 2026-10-04");
  } finally {
    await factory.stop();
    factory.store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
