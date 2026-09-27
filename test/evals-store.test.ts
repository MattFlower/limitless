import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTrial } from "../src/core/types.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { Store } from "../src/db/store.ts";

const row: EvalTrial = {
  evalRunId: "",
  caseId: "a",
  modelId: "opaque-model",
  trial: 0,
  cacheKey: "hash",
  harness: "fake",
  status: "ok",
  output: { risk: "high" },
  pass: false,
  score: 0.5,
  details: { provider: "provider" },
  costUsd: 0.3,
  costEquivUsd: 0.6,
  tokensIn: 10,
  tokensOut: 20,
  durationMs: 15,
  createdAt: 10,
};

test("upgrade to the eval migration preserves data and adds eval columns, cache index, FK and tuple uniqueness", () => {
  const home = mkdtempSync(join(tmpdir(), "eval-store-"));
  const path = join(home, "db.sqlite");
  let store: Store | undefined;
  try {
    const old = new Database(path);
    old.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const evalVersion = MIGRATIONS.find((m) => m.name === "triage_evals")?.version ?? 0;
    for (const migration of MIGRATIONS.filter((m) => m.version < evalVersion)) {
      old.exec(migration.sql);
      old.query("INSERT INTO schema_migrations VALUES (?, ?, 1)").run(migration.version, migration.name);
    }
    old.query("INSERT INTO settings VALUES ('sentinel', 'unchanged')").run();
    old.close();
    store = new Store(path);
    expect(store.db.query("SELECT value FROM settings WHERE key = 'sentinel'").get()).toEqual({
      value: "unchanged",
    });
    expect(store.db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: Math.max(...MIGRATIONS.map((m) => m.version)),
    });
    const columns = (store.db.query("PRAGMA table_info(eval_trials)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual([
      "eval_run_id",
      "case_id",
      "model_id",
      "trial",
      "cache_key",
      "harness",
      "status",
      "output_json",
      "pass",
      "score",
      "details_json",
      "cost_usd",
      "cost_equiv_usd",
      "tokens_in",
      "tokens_out",
      "duration_ms",
      "created_at",
    ]);
    expect(
      (store.db.query("PRAGMA index_list(eval_trials)").all() as { name: string }[]).some(
        (i) => i.name === "eval_trials_cache_key",
      ),
    ).toBe(true);
    expect(() => store?.recordEvalTrial(row)).toThrow();
    const run = store.createEvalRun({ role: "triage", models: ["opaque-model"], k: 2, maxUsd: 1 }, [
      row,
      { ...row, trial: 1, status: "queued", pass: null, score: null, costUsd: 0 },
    ]);
    const saved = { ...row, evalRunId: run.id };
    expect(store.listEvalTrials(run.id)[0]).toEqual(saved);
    expect(() =>
      store?.db.query("INSERT INTO eval_trials SELECT * FROM eval_trials WHERE trial = 0").run(),
    ).toThrow();
    expect(store.cachedEvalTrials("hash")).toEqual([saved]);
    store.recordEvalTrial(saved);
    expect(store.providerSpendSince("provider", 0)).toBe(0.3);
    expect(store.providerSpendSince("opaque-model", 0)).toBe(0);
    store.recordEvalTrial({
      ...row,
      evalRunId: run.id,
      caseId: "interrupted",
      status: "running",
      pass: null,
      score: null,
      costUsd: 0,
    });
    store.updateEvalRun(run.id, "running");
    store.close();
    store = new Store(path);
    expect(store.getEvalRun(run.id)?.status).toBe("running");
    expect(store.listEvalTrials(run.id)[0]).toEqual(saved);
    store.recoverEvals();
    expect(store.getEvalRun(run.id)).toMatchObject({
      status: "failed",
      error: "interrupted by daemon restart; submit a new eval to reuse completed trials",
    });
    expect(store.getEvalRun(run.id)?.finishedAt).toBeNumber();
    expect(store.listEvalTrials(run.id)[1]?.status).toBe("skipped");
    expect(store.listEvalTrials(run.id)[2]).toMatchObject({
      status: "error",
      pass: false,
      score: 0,
      details: { interrupted: true },
    });
    expect(store.listEvalTrials(run.id)[2]?.details.reason).toContain("final usage unknown");
    expect(store.listEvalTrials(run.id)[0]).toEqual(saved);
    const repo = store.upsertRepo({
      slug: "local/test",
      kind: "local",
      localPath: home,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const pipeline = store.createRun(repo, { repo: repo.slug, prompt: "test" });
    const invocation = store.createInvocation({
      runId: pipeline.id,
      stageId: null,
      role: "triage",
      harness: "fake",
      provider: "provider",
      model: "backend",
      modelId: "opaque-model",
    });
    store.updateInvocation(invocation.id, { costUsd: 0.2, status: "ok" });
    store.recordChatCall("chat", "provider", "opaque-model", Date.now(), {
      status: "error",
      finalText: "",
      structured: null,
      sessionId: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      numTurns: 0,
      costUsd: 0.4,
      costEquivUsd: 0.8,
      error: "failed",
      quota: null,
    });
    expect(store.providerSpendSince("provider", 0)).toBeCloseTo(0.9);
    expect(store.providerSpendSince("provider", Date.now() + 1000)).toBe(0);
    for (const status of ["completed", "budget_exhausted", "failed"] as const) {
      const terminal = store.createEvalRun({ role: "triage", models: ["opaque-model"], k: 1, maxUsd: 1 }, []);
      store.updateEvalRun(terminal.id, status);
      const before = store.getEvalRun(terminal.id);
      store.recoverEvals();
      expect(store.getEvalRun(terminal.id)).toEqual(before);
      expect(before?.finishedAt).toBeNumber();
    }
  } finally {
    store?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
