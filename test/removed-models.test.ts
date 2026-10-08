import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { formatEvalReport } from "../src/cli/eval.ts";
import { loadConfig } from "../src/config.ts";
import type { ProviderStatus, RunDetail } from "../src/core/types.ts";
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

test.each(["codex/astra", "retired-lan/legacy"])(
  "stored history naming %s renders and resolves after reopening",
  async (modelId) => {
    const home = mkdtempSync(join(tmpdir(), "limitless-removed-models-"));
    const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "config") });
    let factory = new Factory(cfg);
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
      const provider = modelId.split("/")[0] ?? "";
      const run = store.createRun(repo, {
        repo: repo.slug,
        prompt: "legacy run",
        models: { implement: [modelId, "codex/sol"] },
      });
      const stage = store.startStage(run.id, "implement");
      for (const inv of [
        {
          role: "implement",
          harness: "codex",
          provider,
          model: modelId === "codex/astra" ? "gpt-6-astra" : "historical-backend",
          modelId,
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
      let routes = createHttpRoutes(factory);
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
      expect(detail.invocations.map((i) => i.modelId)).toEqual([modelId, "claude/fable"]);
      expect(detail.invocations[0]?.provider).toBe(provider);
      const report = renderReport({
        success: true,
        runId: run.id,
        prompt: run.prompt,
        state: {},
        invocations: detail.invocations,
        totals: { costUsd: detail.run.costUsd, costEquivUsd: detail.run.costEquivUsd },
        runUrl: "u",
      });
      expect(report).toContain(`| implement | \`${modelId}\` | high | ok |`);
      expect(report).toContain("| review | `claude/fable` | high | ok |");
      const stats = await get<Stats>("/api/stats");
      expect(stats.models.map((m) => m.modelId)).toEqual(expect.arrayContaining([modelId, "claude/fable"]));

      const target = `${modelId}@high`;
      const legacy = evidence("triage", [target]);
      for (const trial of legacy.trials) trial.details.provider = provider;
      const evalRun = store.createEvalRun(legacy.run, legacy.trials, {
        request: { role: "triage", models: [target], k: 1 },
      });
      store.updateEvalRun(evalRun.id, "completed");
      store.setProviderFast("retired-lan", true);
      store.setProviderEnabledOverride("retired-lan", true);
      await factory.stop();
      store.close();
      factory = new Factory(cfg);
      routes = createHttpRoutes(factory);
      const reopened = await get<RunDetail>("/api/runs/:id", { id: run.id });
      expect(reopened.run.models?.implement).toEqual([modelId, "codex/sol"]);
      expect(reopened.invocations[0]?.modelId).toBe(modelId);
      expect((await get<ProviderStatus[]>("/api/providers")).map((p) => p.id)).not.toContain("retired-lan");
      const routed = factory.router.route("implement", "small", {
        chain: reopened.run.models?.implement,
        prefer: { modelId, effort: "high" },
        exclude: [{ modelId, effort: "high" }],
      });
      expect(routed.candidates.map((c) => c.modelId)).toEqual(["codex/sol"]);
      expect(routed.skipped[0]?.reason).toContain("unknown model ID");
      expect(() => factory.router.resolve(modelId)).toThrow("unknown model ID");
      const evalReport = await get<EvalReport>("/api/evals/:id", { id: evalRun.id });
      expect(formatEvalReport(evalReport)).toContain(target);
      const policy = await get<EvalPolicyResponse>("/api/evals/policy");
      expect(policy.evaluation.roles.find((r) => r.role === "triage")?.candidates[0]).toMatchObject({
        modelId: target,
        state: "ineligible",
        reasons: expect.arrayContaining([`${modelId} is not in the model catalog`]),
      });
      expect(policy.evaluation.generated).toEqual({});
      expect(evalMatrix(policy).models).toContain(target);

      // Resuming the eval re-validates its stored request, which names the removed model.
      factory.store.updateEvalRun(evalRun.id, "interrupted");
      const resumed = await call(
        "/api/evals/:id/resume",
        { id: evalRun.id },
        { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
      );
      expect(resumed.status).toBe(400);
      expect(await resumed.text()).toContain(
        modelId === "codex/astra" ? "GPT-6 Astra was removed from routing on 2026-10-04" : "unknown model ID",
      );
    } finally {
      await factory.stop();
      factory.store.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
);
