import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTrial } from "../src/core/types.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { Store } from "../src/db/store.ts";
import { formatEvalReport } from "../src/evals/format.ts";

const row: EvalTrial = {
  effort: null,
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
      "effort",
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
      status: "interrupted",
      // A run without a stored request cannot be resumed.
      error: "interrupted by daemon restart; submit a new eval to rerun it",
    });
    expect(store.getEvalRun(run.id)?.finishedAt).toBeNumber();
    expect(store.listEvalTrials(run.id)[1]?.status).toBe("skipped");
    expect(store.listEvalTrials(run.id)[2]).toMatchObject({
      status: "skipped",
      pass: null,
      score: null,
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

test("effort migration preserves v9 rows and pair upserts survive reopening", () => {
  const home = mkdtempSync(join(tmpdir(), "effort-migration-"));
  const path = join(home, "db.sqlite");
  let store: Store | undefined;
  try {
    const db = new Database(path);
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((m) => m.version < 10)) {
      db.exec(m.sql);
      db.query("INSERT INTO schema_migrations VALUES (?, ?, 1)").run(m.version, m.name);
    }
    db.exec(`
      INSERT INTO repos (id,slug,kind,created_at) VALUES ('repo','local/test','local',1);
      INSERT INTO runs (id,repo_id,title,prompt,source,status,created_at) VALUES ('run','repo','title','prompt','cli','queued',1);
      INSERT INTO invocations (run_id,role,harness,provider,model,model_id,status,started_at) VALUES ('run','triage','fake','provider','backend','opaque-model','ok',1);
      INSERT INTO eval_runs VALUES ('old','triage','["opaque-model"]',1,1,'completed',1,2,NULL);
      INSERT INTO eval_trials VALUES ('old','a','opaque-model',0,'legacy','fake','ok','{}',1,1,'{}',0,0,0,0,1,1);
    `);
    db.close();
    store = new Store(path);
    expect(store.listInvocations("run")[0]?.effort).toBeNull();
    expect(store.listEvalTrials("old")[0]?.effort).toBeNull();
    for (const effort of ["low", "high", "none", "default", null] as const)
      store.recordEvalTrial({ ...row, evalRunId: "old", effort });
    store.recordEvalTrial({ ...row, evalRunId: "old", effort: "low", score: 0.75 });
    // A deliberately unset effort never collides with the legacy (unknown) row.
    expect(store.listEvalTrials("old")).toHaveLength(5);
    const events: unknown[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event));
    const invocation = store.createInvocation({
      runId: "run",
      stageId: null,
      role: "triage",
      harness: "fake",
      provider: "provider",
      model: "backend",
      modelId: "opaque-model",
      effort: "none",
    });
    store.updateInvocation(invocation.id, { status: "cancelled", error: "cancelled" });
    unsubscribe();
    expect(events).toHaveLength(2);
    for (const event of events)
      expect(event).toMatchObject({ kind: "invocation", invocation: { effort: "none" } });
    store.close();
    store = new Store(path);
    expect(
      store
        .listEvalTrials("old")
        .map((t) => t.effort)
        .sort(),
    ).toEqual(([null, "default", "high", "low", "none"] as const).toSorted());
    expect(store.listEvalTrials("old").find((t) => t.effort === "low")?.score).toBe(0.75);
    expect(store.getInvocation(invocation.id)).toMatchObject({ effort: "none", status: "cancelled" });
    expect(store.getRunDetail("run")?.invocations[0]?.effort).toBeNull();
  } finally {
    store?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("round options and evidence survive reload with provider-specific spend and legacy defaults", () => {
  const home = mkdtempSync(join(tmpdir(), "eval-round-store-"));
  const path = join(home, "db.sqlite");
  let store = new Store(path);
  try {
    const run = store.createEvalRun(
      { role: "implement", models: ["a"], k: 1, maxUsd: 2, rounds: 3, strategy: "switch" },
      [],
    );
    const rounds = ["provider", "other"].map((provider, round) => ({
      provider,
      round,
      modelId: provider,
      effort: "low" as const,
      status: "ok" as const,
      pass: round === 1,
      reason: round ? null : "hidden_tests",
      costUsd: round + 1,
      costEquivUsd: round + 2,
      tokensIn: 3,
      tokensOut: 4,
      durationMs: 5,
    }));
    store.recordEvalTrial({
      ...row,
      evalRunId: run.id,
      details: { provider: "provider", rounds, roundsUsed: 2, stopReason: "success" },
    });
    store.close();
    store = new Store(path);
    expect(store.getEvalRun(run.id)).toMatchObject({ rounds: 3, strategy: "switch" });
    const t = store.listEvalTrials(run.id)[0];
    expect(t?.details.rounds).toEqual(rounds);
    expect(store.providerSpendSince("provider", 0)).toBe(1);
    expect(store.providerSpendSince("other", 0)).toBe(2);
    if (!t) throw new Error("missing trial");
    store.recordEvalTrial({
      ...t,
      trial: 1,
      costUsd: 0,
      details: {
        ...t.details,
        cache: {
          evalRunId: run.id,
          caseId: "a",
          costUsd: 3,
          costEquivUsd: 5,
          tokensIn: 6,
          tokensOut: 8,
          durationMs: 10,
        },
      },
    });
    expect(store.providerSpendSince("other", 0)).toBe(2);
    store.db.query("DELETE FROM eval_run_options WHERE eval_run_id = ?").run(run.id);
    expect(store.getEvalRun(run.id)).toMatchObject({ rounds: 1, strategy: "retry" });
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("eval concurrency survives reload and legacy runs omit it", () => {
  const home = mkdtempSync(join(tmpdir(), "eval-concurrency-store-"));
  const path = join(home, "db.sqlite");
  let store = new Store(path);
  try {
    const explicit = store.createEvalRun(
      { role: "triage", models: ["a"], k: 1, maxUsd: 1, concurrency: 7 },
      [],
    );
    const omitted = store.createEvalRun({ role: "triage", models: ["a"], k: 1, maxUsd: 1 }, []);
    expect(explicit.concurrency).toBe(7);
    store.close();
    store = new Store(path);
    expect(store.getEvalRun(explicit.id)?.concurrency).toBe(7);
    expect(store.getEvalRun(omitted.id)?.concurrency).toBe(2);
    // A run written by the previous release has no concurrency row.
    store.db.query("DELETE FROM eval_run_concurrency WHERE eval_run_id = ?").run(explicit.id);
    const legacy = store.getEvalRun(explicit.id);
    expect(legacy?.concurrency).toBeUndefined();
    expect(JSON.parse(JSON.stringify(legacy))).not.toHaveProperty("concurrency");
    const listed = new Map(store.listEvalRuns().map((r) => [r.id, r.concurrency]));
    expect([listed.get(explicit.id), listed.get(omitted.id)]).toEqual([undefined, 2]);
    if (!legacy) throw new Error("missing run");
    expect(formatEvalReport({ run: legacy, summaries: [], trials: [] })).toContain("concurrency=1 (legacy)");
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("resume links persist in both directions and appear in text and JSON reports", () => {
  const home = mkdtempSync(join(tmpdir(), "eval-resume-"));
  const path = join(home, "db.sqlite");
  let store = new Store(path);
  try {
    const input = { role: "triage" as const, models: ["opaque-model"], k: 1, maxUsd: 1 };
    const request = { ...input, cache: true, concurrency: 2 };
    const old = store.createEvalRun(input, [], request);
    store.updateEvalRun(old.id, "failed", "provider exploded");
    const next = store.createEvalRun(input, [], request, old.id);
    expect(() => store.createEvalRun(input, [], request, old.id)).toThrow("already resumed");
    expect(store.listEvalRuns()).toHaveLength(2);
    store.close();
    store = new Store(path);
    expect(store.getEvalRun(old.id)).toMatchObject({
      status: "interrupted",
      error: "provider exploded",
      resumedBy: next.id,
    });
    expect(store.getEvalRun(next.id)).toMatchObject({ status: "queued", resumedFrom: old.id });
    expect(store.evalRequest(next.id)).toEqual(request);
    const report = (id: string) => {
      const run = store.getEvalRun(id);
      if (!run) throw new Error("missing run");
      return { run, summaries: [], trials: [] };
    };
    expect(formatEvalReport(report(old.id))).toContain(`resumed by ${next.id}`);
    expect(formatEvalReport(report(next.id))).toContain(`resumed from ${old.id}`);
    expect(JSON.parse(JSON.stringify(report(next.id))).run.resumedFrom).toBe(old.id);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a restart suggests eval resume only for evals resume would accept", () => {
  const store = new Store(":memory:");
  try {
    const input = { role: "triage" as const, models: ["opaque-model"], k: 1, maxUsd: 1 };
    const run = (request?: unknown) => {
      const created = store.createEvalRun(input, [], request);
      store.updateEvalRun(created.id, "running");
      return created.id;
    };
    const resumable = run({ request: { ...input, cache: true } });
    const uncached = run({ request: { ...input, cache: false } });
    const legacy = run();
    store.recoverEvals();
    expect(store.getEvalRun(resumable)?.error).toBe(
      `interrupted by daemon restart; \`limitless eval resume ${resumable}\` reuses its finished trials`,
    );
    for (const id of [uncached, legacy])
      expect(store.getEvalRun(id)?.error).toBe(
        "interrupted by daemon restart; submit a new eval to rerun it",
      );
  } finally {
    store.close();
  }
});

test("eval spend covers the resume chain without counting copied trials twice", () => {
  const store = new Store(":memory:");
  try {
    const input = { role: "triage" as const, models: ["opaque-model"], k: 1, maxUsd: 1 };
    const trial = (caseId: string, status: EvalTrial["status"], costUsd: number): EvalTrial => ({
      evalRunId: "",
      caseId,
      modelId: "opaque-model",
      effort: "default",
      trial: 0,
      cacheKey: "",
      harness: "fake",
      status,
      output: null,
      pass: null,
      score: null,
      details: {},
      costUsd,
      costEquivUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      createdAt: 1,
    });
    const copy = (t: EvalTrial, from: string): EvalTrial => ({ ...t, details: { resumedFrom: from } });
    // An interrupted multi-round trial keeps its spend while unfinished; a resume reruns it. A
    // finished trial whose cache key changed (c) is rerun too, so both of its calls count.
    const first = store.createEvalRun(
      input,
      [trial("a", "ok", 0.1), trial("b", "skipped", 0.2), trial("c", "ok", 0.4)],
      {},
    );
    store.updateEvalRun(first.id, "interrupted");
    const second = store.createEvalRun(
      input,
      [copy(trial("a", "ok", 0.1), first.id), trial("b", "error", 0.05), trial("c", "ok", 0.4)],
      {},
      first.id,
    );
    expect(store.evalSpend(first.id)).toBeCloseTo(0.7);
    expect(store.evalSpend(second.id)).toBeCloseTo(1.15);
    store.updateEvalRun(second.id, "interrupted");
    const third = store.createEvalRun(
      input,
      [
        copy(trial("a", "ok", 0.1), first.id),
        copy(trial("b", "error", 0.05), second.id),
        copy(trial("c", "ok", 0.4), second.id),
      ],
      {},
      second.id,
    );
    expect(store.evalSpend(third.id)).toBeCloseTo(1.15);
  } finally {
    store.close();
  }
});
