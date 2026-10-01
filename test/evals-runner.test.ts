import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey } from "../src/evals/cache.ts";
import { formatEvalReport } from "../src/evals/format.ts";
import type { EvalReport } from "../src/evals/stats.ts";
import { pinnedTree, withRepoLock } from "../src/git/repos.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import { selectHarness } from "../src/harness/select.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { FACTORY_PREAMBLE, triagePrompt } from "../src/pipeline/prompts.ts";
import { TriageSchema, toStrictJsonSchema } from "../src/pipeline/schemas.ts";
import { sh } from "../src/util/proc.ts";
import { answer, deferred, enableEfforts, evalFixture } from "./evals-support.ts";

test("3 cases x 2 exact models x k=2 use pinned bare inputs and shared invocation semantics", async () => {
  const f = await evalFixture();
  try {
    const arrived = deferred<void>();
    const release = deferred<void>();
    const busy = new Set<string>();
    f.respond(async (s) => {
      expect(busy.has(s.target.modelId)).toBe(false);
      busy.add(s.target.modelId);
      if (busy.size === 2) arrived.resolve();
      await release.promise;
      busy.delete(s.target.modelId);
      return { structured: answer };
    });
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a", "candidate-b"], k: 2 });
    await arrived.promise;
    expect(f.calls).toHaveLength(2);
    release.resolve();
    await f.factory.evals.wait(run.id);
    const report = f.factory.evals.report(run.id);
    expect(report?.run.status).toBe("completed");
    expect(report?.trials).toHaveLength(12);
    expect(f.calls).toHaveLength(12);
    for (const model of run.models) {
      expect(f.calls.filter((s) => s.target.modelId === model).map((s) => s.prompt)).toEqual(
        f.dataset.cases.flatMap((item) =>
          Array(2).fill(triagePrompt({ repoSlug: item.repo, prompt: item.prompt, tree: "PINNED.txt" })),
        ),
      );
    }
    for (const spec of f.calls) {
      expect(spec.systemAppend).toBe(FACTORY_PREAMBLE);
      expect(spec.jsonSchema).toEqual(toStrictJsonSchema(TriageSchema));
      expect(spec.schema).toBe(TriageSchema);
      expect(spec.noTools).toBe(true);
      expect(spec.mode).toBe("readonly");
      expect(spec.prompt).not.toContain("CURRENT.txt");
      expect(spec.prompt).not.toContain("SECRET_TAG");
      expect(spec.prompt).not.toContain('"gold"');
      expect(spec.cwd).not.toBe(f.source);
      expect(existsSync(spec.cwd)).toBe(false);
    }
    expect(new Set(f.harnessNames)).toEqual(new Set(["llm", "fake"]));
    expect(existsSync(join(f.cache, "worktrees"))).toBe(false);
    expect((await sh(["git", "rev-parse", "--is-bare-repository"], { cwd: f.cache })).stdout.trim()).toBe(
      "true",
    );
    expect(readFileSync(join(f.source, "CURRENT.txt"), "utf8")).toBe("new");
    const target = f.calls[0]?.target;
    if (!target) throw new Error("missing target");
    for (const role of ["triage", "chat", "summarize"] as const) {
      expect(selectHarness(role, { ...target, openai: { baseUrl: "unused", authToken: "" } })).toEqual({
        harnessName: "llm",
        noTools: true,
      });
      expect(selectHarness(role, { ...target, openai: undefined })).toEqual({
        harnessName: "fake",
        noTools: true,
      });
    }
    expect(selectHarness("implement", target)).toEqual({ harnessName: "fake", noTools: false });
    expect(selectHarness("holdout", target, true)).toEqual({ harnessName: "fake", noTools: true });
  } finally {
    await f.close();
  }
});

test("cache reuses schema-valid successes including grade failures; regrades current gold with zero spend", async () => {
  const f = await evalFixture();
  try {
    f.respond(() => ({ structured: answer, costUsd: 0.02, costEquivUsd: 0.04, delayMs: 2 }));
    const first = await f.run();
    expect(first.trials).toHaveLength(12);
    const calls = f.calls.length;
    for (const item of f.dataset.cases) item.gold.risk = "high";
    f.save();
    const second = await f.run();
    expect(f.calls).toHaveLength(calls);
    expect(second.trials.every((t) => t.status === "ok" && t.pass === false)).toBe(true);
    expect(
      second.trials.every(
        (t) =>
          t.costUsd === 0 &&
          t.costEquivUsd === 0 &&
          t.tokensIn === 0 &&
          t.tokensOut === 0 &&
          t.durationMs === 0,
      ),
    ).toBe(true);
    expect(second.trials[0]?.details.cache).toMatchObject({
      evalRunId: first.run.id,
      costUsd: 0.02,
      costEquivUsd: 0.04,
      tokensIn: 100,
    });
    expect(second.summaries.every((s) => s.p50LatencyMs === null && s.cached === 6)).toBe(true);
    expect(f.factory.store.providerSpendSince("openrouter", 0)).toBeCloseTo(0.12);
    expect(f.factory.evals.report(first.run.id)?.trials.every((t) => t.pass)).toBe(true);
    const third = await f.run();
    expect(f.calls).toHaveLength(calls);
    expect(third.trials[0]?.details.cache?.evalRunId).toBe(first.run.id);
    await f.run({ cache: false });
    expect(f.calls).toHaveLength(calls * 2);
  } finally {
    await f.close();
  }
});

test("cache identity includes every invocation component and ignores schema object key order", () => {
  const base = cacheKey("model", "fake", "prompt", "system", { a: 1, b: 2 }, 0);
  for (const key of [
    cacheKey("other", "fake", "prompt", "system", { a: 1, b: 2 }, 0),
    cacheKey("model", "llm", "prompt", "system", { a: 1, b: 2 }, 0),
    cacheKey("model", "fake", "changed", "system", { a: 1, b: 2 }, 0),
    cacheKey("model", "fake", "prompt", "changed", { a: 1, b: 2 }, 0),
    cacheKey("model", "fake", "prompt", "system", { a: 2, b: 2 }, 0),
    cacheKey("model", "fake", "prompt", "system", { a: 1, b: 2 }, 1),
    cacheKey("model", "fake", "prompt", "system", { a: 1, b: 2 }, 0, undefined, undefined, [["p", "m"]]),
  ])
    expect(key).not.toBe(base);
  expect(cacheKey("model", "fake", "prompt", "system", { b: 2, a: 1 }, 0)).toBe(base);
});

test("invalid and non-ok stored outputs never satisfy cache lookup", async () => {
  const f = await evalFixture();
  try {
    const first = await f.run({ models: ["candidate-a"], k: 1, caseIds: ["a"] });
    const t = first.trials[0];
    if (!t) throw new Error("missing trial");
    f.factory.store.recordEvalTrial({ ...t, output: { risk: "low" } });
    await f.run({ models: ["candidate-a"], k: 1, caseIds: ["a"] });
    expect(f.calls).toHaveLength(2);
    for (const r of f.factory.store.listEvalRuns())
      for (const row of f.factory.store.listEvalTrials(r.id))
        f.factory.store.recordEvalTrial({ ...row, status: "error" });
    await f.run({ models: ["candidate-a"], k: 1, caseIds: ["a"] });
    expect(f.calls).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test("zero and exact budgets skip all remaining work; unsuccessful calls retain full costs", async () => {
  const f = await evalFixture();
  try {
    const zero = await f.run({ maxUsd: 0 });
    expect(zero.run.status).toBe("budget_exhausted");
    expect(
      zero.trials.every((t) => t.status === "skipped" && t.details.reason === "eval budget exhausted"),
    ).toBe(true);
    expect(f.calls).toHaveLength(0);
    f.respond(() => ({ status: "error", error: "bad output", costUsd: 0.5, costEquivUsd: 50 }));
    const report = await f.run({ models: ["candidate-a"], maxUsd: 0.5 });
    expect(f.calls).toHaveLength(1);
    expect(report.run.status).toBe("budget_exhausted");
    expect(report.trials[0]).toMatchObject({ status: "error", pass: false, score: 0, costUsd: 0.5 });
    expect(report.trials.filter((t) => t.status === "skipped")).toHaveLength(5);
    expect(f.factory.store.providerSpendSince("openrouter", 0)).toBe(0.5);
    f.respond(() => ({ structured: answer, costEquivUsd: 100 }));
    expect((await f.run({ models: ["candidate-a"], cache: false })).run.status).toBe("completed");
  } finally {
    await f.close();
  }
});

test("in-flight cross-provider overshoot is retained; no calls dispatch after exhaustion", async () => {
  const f = await evalFixture();
  try {
    const started = deferred<void>();
    const finish = deferred<void>();
    f.respond(async () => {
      if (f.calls.length === 2) started.resolve();
      await finish.promise;
      return { structured: answer, costUsd: 0.75 };
    });
    const run = f.factory.evals.submit({
      role: "triage",
      models: ["candidate-a", "candidate-b"],
      k: 2,
      maxUsd: 0.5,
    });
    await started.promise;
    finish.resolve();
    await f.factory.evals.wait(run.id);
    expect(f.calls).toHaveLength(2);
    expect(f.factory.store.evalSpend(run.id)).toBe(1.5);
    expect(f.factory.evals.report(run.id)?.run.status).toBe("budget_exhausted");
  } finally {
    await f.close();
  }
});

test("capacity wait rechecks eligibility and shares slots with other daemon operations", async () => {
  for (const kind of ["reserve", "provider budget", "model", "eval budget"] as const) {
    const f = await evalFixture();
    try {
      const release = await f.factory.tracker.acquire("openrouter", new AbortController().signal);
      const waiting = deferred<void>();
      const acquire = f.factory.tracker.acquire.bind(f.factory.tracker);
      const spy = spyOn(f.factory.tracker, "acquire").mockImplementation((id, signal) => {
        waiting.resolve();
        return acquire(id, signal);
      });
      const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1 });
      await waiting.promise;
      spy.mockRestore();
      expect(f.calls).toHaveLength(0);
      if (kind === "reserve")
        f.factory.tracker.observeWindows("openrouter", {
          five_hour: { utilization: 1, resetsAt: Date.now() + 60_000 },
        });
      if (kind === "model") f.factory.tracker.blockModel("candidate-a", "not supported");
      if (kind === "provider budget" || kind === "eval budget") {
        const t = f.factory.store.listEvalTrials(run.id)[0];
        if (!t) throw new Error("missing");
        // Simulate a concurrently completed invocation (eval-wide or provider-wide spend).
        const other = f.factory.store.createEvalRun(
          { role: "triage", models: ["candidate-a"], k: 1, maxUsd: 200 },
          [],
        );
        f.factory.store.recordEvalTrial({
          ...t,
          evalRunId: kind === "eval budget" ? run.id : other.id,
          caseId: "concurrent",
          status: "ok",
          costUsd: kind === "eval budget" ? 1 : 100,
          details: { provider: "openrouter" },
        });
        f.factory.store.updateEvalRun(other.id, "completed");
      }
      release();
      await f.factory.evals.wait(run.id);
      expect(f.calls).toHaveLength(0);
      const rows = f.factory.store.listEvalTrials(run.id).filter((t) => t.status === "skipped");
      expect(rows).toHaveLength(3);
      expect(rows[0]?.details.reason).toContain(
        kind === "reserve" ? "reserve" : kind === "model" ? "model rejected" : "budget exhausted",
      );
      expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test("unavailable candidates, quota, circuit breakers, missing harnesses and throws remain explicit", async () => {
  const f = await evalFixture();
  try {
    f.factory.tracker.setHealthy("openrouter", false);
    const unavailable = await f.run();
    expect(
      unavailable.trials
        .filter((t) => t.modelId === "candidate-a")
        .every((t) => t.details.reason === "server not reachable"),
    ).toBe(true);
    expect(f.calls.every((s) => s.target.modelId === "candidate-b")).toBe(true);
    f.factory.tracker.setHealthy("openrouter", true);
    f.respond(() => ({
      status: "quota",
      error: "quota exhausted",
      costUsd: 0.1,
      quota: { windows: {}, exhaustedUntil: Date.now() + 60_000 },
    }));
    const quota = await f.run({ models: ["candidate-a"], cache: false });
    expect(quota.trials[0]?.status).toBe("error");
    expect(quota.trials[1]?.details.reason).toContain("quota exhausted");
    f.respond(() => {
      throw new Error("fake exception");
    });
    const thrown = await f.run({ models: ["candidate-b"], cache: false });
    expect(thrown.trials.every((t) => t.details.reason === "fake exception")).toBe(true);
    expect(f.factory.tracker.status("provider-b")?.inFlight).toBe(0);
    const fake = f.factory.deps.harnesses.fake;
    if (!fake) throw new Error("missing fake");
    delete f.factory.deps.harnesses.fake;
    const missing = await f.run({ models: ["candidate-b"], cache: false });
    expect(missing.trials.every((t) => t.details.reason === "No harness registered for fake")).toBe(true);
    f.factory.deps.harnesses.fake = fake;
    for (let i = 0; i < 5; i++) f.factory.tracker.record("provider-b", "unavailable");
    const circuit = await f.run({ models: ["candidate-b"], cache: false });
    expect(circuit.trials[0]?.details.reason).toContain("circuit open");
  } finally {
    await f.close();
  }
});

test("shutdown aborts active and waiting trials, releases slots, and preserves partial output", async () => {
  const f = await evalFixture();
  try {
    const entered = deferred<void>();
    f.respond(async (s) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { structured: answer };
    });
    // Evals share max - 1 = 2 slots; production work holds the rest so the second eval waits on the tracker.
    setLimit(f, "openrouter", 3);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], concurrency: 1 });
    await entered.promise;
    const held = new AbortController().signal;
    const production = [
      await f.factory.tracker.acquire("openrouter", held),
      await f.factory.tracker.acquire("openrouter", held),
    ];
    const acquiring = deferred<void>();
    const acquire = f.factory.tracker.acquire.bind(f.factory.tracker);
    const spy = spyOn(f.factory.tracker, "acquire").mockImplementation((id, signal) => {
      acquiring.resolve();
      return acquire(id, signal);
    });
    const waiting = f.factory.evals.submit({ role: "triage", models: ["candidate-a"] });
    await acquiring.promise;
    spy.mockRestore();
    await f.factory.stop();
    for (const release of production) release();
    expect(f.factory.evals.report(run.id)?.run).toMatchObject({
      status: "interrupted",
      error: "eval interrupted by daemon shutdown",
    });
    expect(f.factory.evals.report(waiting.id)?.run.status).toBe("interrupted");
    const report = f.factory.evals.report(waiting.id);
    expect(report?.trials).toHaveLength(3);
    for (const trial of report?.trials ?? []) {
      expect(trial).toMatchObject({
        status: "skipped",
        pass: null,
        score: null,
        // The waiting trial aborts; trials never dequeued are skipped by the run's interruption.
        details: { reason: expect.stringContaining("daemon shutdown") },
      });
      expect(trial.details.preparationFailed).toBeUndefined();
    }
    expect(report?.summaries[0]).toMatchObject({
      evaluatedTrials: 0,
      errors: 0,
      skipped: 3,
      passRate: null,
      predictionTrials: 0,
      latencyDenominator: 0,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    expect(
      f.factory.store.listEvalTrials(run.id).every((t) => !["running", "queued"].includes(t.status)),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("bare cache clones/fetches exact pins under existing locks, and never substitutes HEAD", async () => {
  const f = await evalFixture();
  try {
    f.factory.store.upsertRepo({
      slug: "fixture/repo",
      kind: "github",
      url: f.source,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    rmSync(f.cache, { recursive: true, force: true });
    expect(
      await Promise.all([
        pinnedTree(f.cfg.paths, f.factory.store, "fixture/repo", f.sha),
        pinnedTree(f.cfg.paths, f.factory.store, "fixture/repo", f.sha),
      ]),
    ).toEqual(["PINNED.txt", "PINNED.txt"]);
    const hold = deferred<void>();
    const entered = deferred<void>();
    const lock = withRepoLock(f.cache, async () => {
      entered.resolve();
      await hold.promise;
    });
    await entered.promise;
    let complete = false;
    const read = pinnedTree(f.cfg.paths, f.factory.store, "fixture/repo", f.sha).then((tree) => {
      complete = true;
      return tree;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    hold.resolve();
    await lock;
    expect(await read).toBe("PINNED.txt");
    writeFileSync(join(f.source, "FETCHED.txt"), "newer");
    await sh(["git", "add", "."], { cwd: f.source });
    await sh(["git", "commit", "-qm", "new pin"], { cwd: f.source });
    const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
    expect(await pinnedTree(f.cfg.paths, f.factory.store, "fixture/repo", sha)).toBe(
      "CURRENT.txt  FETCHED.txt",
    );
    f.dataset.repos["fixture/repo"] = "0".repeat(40);
    f.save();
    const missing = await f.run();
    // A missing pin fails each of its cases' preparation, never the whole run.
    expect(missing.run.status).toBe("completed");
    expect(f.calls).toHaveLength(0);
    for (const trial of missing.trials) {
      expect(trial).toMatchObject({ status: "error", pass: false, details: { preparationFailed: true } });
      expect(String(trial.details.reason)).toContain("0000000000");
    }
    expect(existsSync(join(f.cache, "worktrees"))).toBe(false);
  } finally {
    await f.close();
  }
});

test("live and final quota telemetry stop later calls; cache replay does not update tracker", async () => {
  const f = await evalFixture();
  try {
    const windows = { five_hour: { utilization: 1, resetsAt: Date.now() + 60_000 } };
    f.respond((spec) => {
      spec.onEvent({ type: "rate_limit", status: "allowed", windows, resetsAt: null });
      return { structured: answer, quota: { windows, exhaustedUntil: null } };
    });
    const limited = await f.run({ models: ["candidate-a"] });
    expect(f.calls).toHaveLength(1);
    expect(limited.trials[1]?.details.reason).toBe("at reserve limit");
    // Cached outputs are usable even when the provider has just hit its reserve.
    expect(f.factory.tracker.unavailableReason("openrouter")).toBe("at reserve limit");
    const record = spyOn(f.factory.tracker, "record");
    const observe = spyOn(f.factory.tracker, "observeWindows");
    const cached = await f.run({ models: ["candidate-a"], caseIds: ["a"], k: 1 });
    expect(cached.summaries[0]?.cached).toBe(1);
    expect(record).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    record.mockRestore();
    observe.mockRestore();
  } finally {
    await f.close();
  }
});

test("two efforts execute independently, cache only equivalent targets, and freeze submitted defaults", async () => {
  const { enableEfforts } = await import("./evals-support.ts");
  const f = await evalFixture();
  try {
    const model = enableEfforts(f);
    const request = { role: "triage", models: ["candidate-a", "candidate-a@high"], k: 1, caseIds: ["a"] };
    const run = f.factory.evals.submit(request);
    // Submission is synchronous; execution starts on the next microtask.
    model.effort = "none";
    await f.factory.evals.wait(run.id);
    expect(f.calls.map((s) => s.target.effort)).toEqual(["low", "high"]);
    const report = f.factory.evals.report(run.id);
    expect(report?.trials.map((t) => [t.modelId, t.effort])).toEqual([
      ["candidate-a", "low"],
      ["candidate-a", "high"],
    ]);
    expect(report?.summaries.map((s) => [s.modelId, s.evaluatedTrials])).toEqual([
      ["candidate-a@low", 1],
      ["candidate-a@high", 1],
    ]);
    const reuse = await f.run({ ...request, models: ["candidate-a@low", "candidate-a@high"] });
    expect(f.calls).toHaveLength(2);
    expect(reuse.summaries.every((s) => s.cached === 1)).toBe(true);
    const different = await f.run({ ...request, models: ["candidate-a"] });
    expect(f.calls.at(-1)?.target.effort).toBe("none");
    expect(different.summaries[0]?.cached).toBe(0);
    model.effort = "low";
    const alias = await f.run({ ...request, models: ["candidate-a"] });
    expect(alias.summaries[0]?.cached).toBe(1);
    const key = (effort?: string | null) =>
      cacheKey("candidate-a", "fake", "prompt", "system", {}, 0, { repo: "pin" }, effort);
    // Legacy (unknown) and deliberately unset ("default") entries never share a key.
    expect(key(null)).toBe(key());
    expect(new Set([key(), key("default"), key("none"), key("low"), key("high")]).size).toBe(5);
  } finally {
    await f.close();
  }
});

test("saved unset effort remains unset after the catalog gains a default", async () => {
  const { enableEfforts } = await import("./evals-support.ts");
  const f = await evalFixture();
  try {
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1, caseIds: ["a"] });
    enableEfforts(f);
    await f.factory.evals.wait(run.id);
    expect(f.calls[0]?.target.effort).toBeUndefined();
    expect(f.factory.evals.report(run.id)?.trials[0]?.effort).toBe("default");
  } finally {
    await f.close();
  }
});

type Fixture = Awaited<ReturnType<typeof evalFixture>>;
function setLimit(f: Fixture, provider: string, maxConcurrent: number) {
  const def = f.factory.tracker.def(provider);
  if (!def) throw new Error(`missing provider ${provider}`);
  def.maxConcurrent = maxConcurrent;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 2000 && !check(); i++) await Bun.sleep(1);
  if (!check()) throw new Error("condition never held");
}
/** Holds every fake call until released, tracking how many are active at once. */
function gate(f: Fixture, reply: () => FakeReply = () => ({ structured: answer })) {
  const state = { active: 0, max: 0, open: deferred<void>() };
  f.respond(async () => {
    state.max = Math.max(state.max, ++state.active);
    await state.open.promise;
    state.active--;
    return reply();
  });
  return state;
}

test("concurrency runs N trials at once per provider when the provider allows more", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 3);
    const state = gate(f);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 2 });
    expect(run.concurrency).toBe(2);
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(f.calls).toHaveLength(2);
    state.open.resolve();
    await f.factory.evals.wait(run.id);
    const report = f.factory.evals.report(run.id);
    expect(state.max).toBe(2);
    expect(report?.run).toMatchObject({ status: "completed", concurrency: 2 });
    expect(report?.trials.every((t) => t.status === "ok")).toBe(true);
    expect(f.calls).toHaveLength(6);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

test("omitted concurrency defaults to 2", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 5);
    const state = gate(f);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2 });
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(state.active).toBe(2);
    state.open.resolve();
    await f.factory.evals.wait(run.id);
    expect(state.max).toBe(2);
    expect(f.factory.evals.report(run.id)?.run.concurrency).toBe(2);
  } finally {
    await f.close();
  }
});

test("provider limits and slots held by other daemon work cap eval concurrency", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 1);
    let state = gate(f);
    const first = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 3 });
    await until(() => state.active === 1);
    await Bun.sleep(20);
    state.open.resolve();
    await f.factory.evals.wait(first.id);
    expect(state.max).toBe(1);
    expect(f.calls).toHaveLength(6);

    // Evals take at most max - 1 = 3 slots; two held by other work leave them 2.
    setLimit(f, "openrouter", 4);
    const held = new AbortController().signal;
    const release = await f.factory.tracker.acquire("openrouter", held);
    const releaseOther = await f.factory.tracker.acquire("openrouter", held);
    state = gate(f);
    const second = f.factory.evals.submit({
      role: "triage",
      models: ["candidate-a"],
      k: 2,
      concurrency: 3,
      cache: false,
    });
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(state.active).toBe(2);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(4);
    release();
    await until(() => state.active === 3);
    await Bun.sleep(20);
    releaseOther();
    state.open.resolve();
    await f.factory.evals.wait(second.id);
    expect(state.max).toBe(3);
    expect(f.factory.evals.report(second.id)?.run.status).toBe("completed");
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

test("budget stops new trials while concurrent in-flight trials finish and keep their costs", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 4);
    const state = gate(f, () => ({ structured: answer, costUsd: 0.5 }));
    const run = f.factory.evals.submit({
      role: "triage",
      models: ["candidate-a"],
      k: 2,
      concurrency: 3,
      maxUsd: 0.5,
    });
    await until(() => state.active === 3);
    state.open.resolve();
    await f.factory.evals.wait(run.id);
    const report = f.factory.evals.report(run.id);
    expect(f.calls).toHaveLength(3);
    expect(f.factory.store.evalSpend(run.id)).toBe(1.5);
    expect(report?.run.status).toBe("budget_exhausted");
    expect(report?.trials.filter((t) => t.status === "ok")).toHaveLength(3);
    const skipped = report?.trials.filter((t) => t.status === "skipped") ?? [];
    expect(skipped).toHaveLength(3);
    expect(skipped.every((t) => t.details.reason === "eval budget exhausted")).toBe(true);
  } finally {
    await f.close();
  }
});

test("shutdown interrupts concurrent trials, releases slots, and a resubmission reuses cached trials", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 3);
    let active = 0;
    f.respond(async (s) => {
      // The first two calls complete; the rest hold until the daemon stops.
      if (f.calls.length <= 2) return { structured: answer };
      active++;
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { structured: answer };
    });
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 2 });
    await until(() => active === 2);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(2);
    await f.factory.stop();
    const report = f.factory.evals.report(run.id);
    expect(report?.run).toMatchObject({
      status: "interrupted",
      error: "eval interrupted by daemon shutdown",
    });
    expect(report?.trials.every((t) => !["queued", "running"].includes(t.status))).toBe(true);
    expect(report?.trials.filter((t) => t.status === "ok")).toHaveLength(2);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    expect(f.calls).toHaveLength(4);

    const { EvalRunner } = await import("../src/evals/runner.ts");
    const runner = new EvalRunner(f.factory.deps, f.casePath);
    f.respond(() => ({ structured: answer }));
    const again = runner.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 2 });
    await runner.wait(again.id);
    const resumed = runner.report(again.id);
    expect(resumed?.run.status).toBe("completed");
    expect(resumed?.trials.filter((t) => t.details.cache?.evalRunId === run.id)).toHaveLength(2);
    expect(f.calls).toHaveLength(8);
  } finally {
    await f.close();
  }
});

test("completion order never changes cache keys, grades or report order", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 4);
    // Case b fails its gold so grades differ across cases.
    const reply = (s: { prompt: string }) => ({
      structured: s.prompt.includes("Fix b") ? { ...answer, risk: "high" as const } : answer,
    });
    f.respond(reply);
    const sequential = await f.run({ models: ["candidate-a"], concurrency: 1, cache: false });
    const pending: (() => void)[] = [];
    f.respond(async (s) => {
      const done = deferred<void>();
      pending.push(() => done.resolve());
      // Release each batch of three in reverse submission order.
      if (pending.length === 3)
        for (const [i, resolve] of pending.splice(0).reverse().entries()) setTimeout(resolve, i * 5);
      await done.promise;
      return reply(s);
    });
    const reversed = await f.run({ models: ["candidate-a"], concurrency: 3, cache: false });
    const view = (r: typeof sequential) =>
      r.trials.map((t) => [t.caseId, t.modelId, t.trial, t.cacheKey, t.status, t.pass, t.score, t.output]);
    expect(view(reversed)).toEqual(view(sequential));
    expect(view(sequential).map((t) => t[5])).toEqual([true, true, false, false, true, true]);
    expect(reversed.summaries.map((s) => [s.passRate, s.evaluatedTrials])).toEqual(
      sequential.summaries.map((s) => [s.passRate, s.evaluatedTrials]),
    );
  } finally {
    await f.close();
  }
});

test("concurrent trials sharing a cache key reuse the earliest queued trial regardless of completion", async () => {
  for (const failFirst of [false, true]) {
    const f = await evalFixture();
    try {
      setLimit(f, "openrouter", 4);
      for (const item of f.dataset.cases) item.prompt = "same";
      f.save();
      const held = deferred<void>();
      f.respond(async () => {
        const call = f.calls.length;
        if (call === 1) {
          await held.promise;
          return failFirst ? { status: "error" as const, error: "boom" } : { structured: answer };
        }
        return { structured: { ...answer, risk: "high" as const } };
      });
      const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1, concurrency: 3 });
      await until(() => f.calls.length === 1);
      await Bun.sleep(30);
      // Later trials with the same key wait for the first instead of racing it.
      expect(f.calls).toHaveLength(1);
      held.resolve();
      await f.factory.evals.wait(run.id);
      const trials = f.factory.evals.report(run.id)?.trials ?? [];
      expect(trials.map((t) => [t.caseId, t.status, t.details.cache?.caseId ?? null])).toEqual(
        failFirst
          ? [
              ["a", "error", null],
              ["b", "ok", null],
              ["c", "ok", "b"],
            ]
          : [
              ["a", "ok", null],
              ["b", "ok", "a"],
              ["c", "ok", "a"],
            ],
      );
      expect(f.calls).toHaveLength(failFirst ? 2 : 1);
    } finally {
      await f.close();
    }
  }
});

test("concurrent eval runs share max - 1 provider slots, leaving one for production", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 3);
    const state = gate(f);
    const request = { role: "triage", models: ["candidate-a"], k: 2, concurrency: 3, cache: false };
    const runs = [f.factory.evals.submit(request), f.factory.evals.submit(request)];
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(state.active).toBe(2);
    // Production work still gets the remaining slot while both evals have queued trials.
    const release = await f.factory.tracker.acquire("openrouter", new AbortController().signal);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(3);
    release();
    state.open.resolve();
    for (const run of runs) await f.factory.evals.wait(run.id);
    expect(state.max).toBe(2);
    expect(runs.map((run) => f.factory.evals.report(run.id)?.run.status)).toEqual(["completed", "completed"]);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

test("the shared eval cap follows the largest concurrency among running evals", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 5);
    let state = gate(f);
    const submit = (concurrency: number) =>
      f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency, cache: false });
    // Own caps of 1 and 2 would allow 3, but the shared cap is the largest request, 2.
    const runs = [submit(1), submit(2)];
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(state.active).toBe(2);
    // A run asking for 3 raises the shared cap to 3 (still under max - 1 = 4).
    runs.push(submit(3));
    await until(() => state.active === 3);
    await Bun.sleep(20);
    expect(state.active).toBe(3);
    state.open.resolve();
    for (const run of runs) await f.factory.evals.wait(run.id);
    expect(state.max).toBe(3);
    // Once they finish the shared cap shrinks back: two concurrency-1 runs share one slot.
    state = gate(f);
    const later = [submit(1), submit(1)];
    await until(() => state.active === 1);
    await Bun.sleep(20);
    expect(state.active).toBe(1);
    state.open.resolve();
    for (const run of later) await f.factory.evals.wait(run.id);
    expect(state.max).toBe(1);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

test("resume replays an interrupted eval's stored request and copies its finished trials", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 3);
    let active = 0;
    f.respond(async (s) => {
      if (f.calls.length <= 2) return { structured: answer };
      active++;
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { structured: answer };
    });
    const request = {
      role: "triage",
      models: ["candidate-a"],
      caseIds: ["a", "b", "c"],
      k: 2,
      concurrency: 2,
    };
    const run = f.factory.evals.submit(request);
    await until(() => active === 2);
    await f.factory.stop();
    // A restart only marks unfinished evals; nothing runs until an explicit resume.
    const { EvalRunner } = await import("../src/evals/runner.ts");
    const runner = new EvalRunner(f.factory.deps, f.casePath);
    await Bun.sleep(20);
    expect(f.calls).toHaveLength(4);
    expect(runner.report(run.id)?.run.status).toBe("interrupted");
    const state = gate(f);
    const resumed = runner.resume(run.id);
    expect(resumed).toMatchObject({ resumedFrom: run.id, status: "queued" });
    expect(f.factory.store.evalRequest(resumed?.id ?? "")).toEqual({
      request: { ...request, models: ["candidate-a@default"], maxUsd: 1, cache: true },
    });
    await until(() => state.active === 2);
    await Bun.sleep(20);
    state.open.resolve();
    await runner.wait(resumed?.id ?? "");
    const report = runner.report(resumed?.id ?? "");
    expect(report?.run.status).toBe("completed");
    const finished = runner.report(run.id)?.trials.filter((t) => t.status === "ok") ?? [];
    expect(finished).toHaveLength(2);
    for (const trial of finished)
      expect(report?.trials).toContainEqual({
        ...trial,
        evalRunId: resumed?.id ?? "",
        details: { ...trial.details, resumedFrom: run.id },
      });
    expect(f.calls).toHaveLength(8);
    expect(state.max).toBe(2);
    expect(runner.report(run.id)?.run).toMatchObject({ status: "interrupted", resumedBy: resumed?.id });
    expect(() => runner.resume(run.id)).toThrow(`already resumed as ${resumed?.id}`);
    expect(() => runner.resume(resumed?.id ?? "")).toThrow("is completed");
  } finally {
    await f.close();
  }
});

test("resume refuses unknown, active, legacy, cache-disabled and no-longer-valid evals without a new run", async () => {
  const f = await evalFixture();
  try {
    const { store, evals } = f.factory;
    expect(evals.resume("missing")).toBeNull();
    const stored = (request: Record<string, unknown> | undefined) => {
      const run = store.createEvalRun(
        { role: "triage", models: ["candidate-a"], k: 1, maxUsd: 1 },
        [],
        request && { request },
      );
      store.updateEvalRun(run.id, "failed", "boom");
      return run.id;
    };
    const valid = { role: "triage", models: ["candidate-a"], k: 1, maxUsd: 1, cache: true, concurrency: 2 };
    const refusals: [string, string][] = [
      [stored(undefined), "cannot be reconstructed"],
      [stored({ ...valid, cache: false }), "cache disabled"],
      [stored({ ...valid, models: ["retired-model"] }), "retired-model"],
      [stored({ ...valid, caseIds: ["c"] }), "Unknown case ID: c"],
    ];
    f.dataset.cases = f.dataset.cases.filter((c) => c.id !== "c");
    f.save();
    const entered = deferred<void>();
    f.respond(async (s) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { structured: answer };
    });
    const active = evals.submit({ role: "triage", models: ["candidate-a"] });
    await entered.promise;
    refusals.push([active.id, "still running"]);
    const count = store.listEvalRuns().length;
    for (const [id, reason] of refusals) expect(() => evals.resume(id)).toThrow(reason);
    expect(store.listEvalRuns()).toHaveLength(count);
    expect(store.getEvalRun(refusals[0]?.[0] ?? "")?.status).toBe("failed");
  } finally {
    await f.close();
  }
});

test("resume replays the selected cases and unset effort, not today's dataset or model default", async () => {
  const f = await evalFixture();
  try {
    const { store, evals } = f.factory;
    const interrupted = async () => {
      const run = evals.submit({ role: "triage", models: ["candidate-a"] });
      await evals.cancel(run.id);
      return run.id;
    };
    const first = await interrupted();
    const second = await interrupted();
    expect(store.evalRequest(first)).toMatchObject({ request: { caseIds: ["a", "b", "c"] } });
    enableEfforts(f);
    const resumed = evals.resume(first);
    await evals.wait(resumed?.id ?? "");
    const trials = evals.report(resumed?.id ?? "")?.trials ?? [];
    expect(trials.map((t) => [t.caseId, t.effort])).toEqual([
      ["a", "default"],
      ["b", "default"],
      ["c", "default"],
    ]);
    f.dataset.cases = f.dataset.cases.filter((c) => c.id !== "b");
    f.save();
    const count = store.listEvalRuns().length;
    expect(() => evals.resume(second)).toThrow("Unknown case ID: b");
    expect(store.listEvalRuns()).toHaveLength(count);
  } finally {
    await f.close();
  }
});

test("cancel stops scheduling, aborts in-flight trials unscored and releases slots", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 3);
    let active = 0;
    f.respond(async (s) => {
      active++;
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { structured: answer };
    });
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 2 });
    await until(() => active === 2);
    expect(await f.factory.evals.cancel(run.id)).toMatchObject({
      status: "interrupted",
      error: "eval cancelled",
    });
    await Bun.sleep(20);
    expect(f.calls).toHaveLength(2);
    const report = f.factory.evals.report(run.id);
    expect(report?.trials).toHaveLength(6);
    for (const trial of report?.trials ?? [])
      expect(trial).toMatchObject({ status: "skipped", pass: null, score: null });
    expect(report?.summaries[0]).toMatchObject({ evaluatedTrials: 0, errors: 0, pending: 0, skipped: 6 });
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    await expect(f.factory.evals.cancel(run.id)).rejects.toThrow("not running");
    expect(await f.factory.evals.cancel("missing")).toBeNull();
  } finally {
    await f.close();
  }
});

/** Submits a sequential triage eval and cancels it once the call for `hang` starts. */
async function interruptedAt(f: Fixture, hang: string, reply: (s: AgentSpec) => FakeReply, over = {}) {
  const entered = deferred<void>();
  f.respond(async (s) => {
    if (!s.prompt.includes(`Fix ${hang}`)) return reply(s);
    entered.resolve();
    await new Promise<void>((resolve) => s.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { structured: answer };
  });
  const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], ...over });
  await entered.promise;
  await f.factory.evals.cancel(run.id);
  return run.id;
}

test("resume copies errored trials with their grades and counts the chain's spend against maxUsd", async () => {
  const f = await evalFixture();
  try {
    const first = await interruptedAt(
      f,
      "c",
      (s) => ({ structured: s.prompt.includes("Fix b") ? {} : answer, costUsd: 0.1 }),
      { maxUsd: 0.25 },
    );
    const calls = f.calls.length;
    expect(f.factory.store.providerSpendSince("openrouter", 0)).toBeCloseTo(0.2);
    f.respond(() => ({ structured: answer, costUsd: 0.1 }));
    const resumed = f.factory.evals.resume(first);
    await f.factory.evals.wait(resumed?.id ?? "");
    // Copies keep their spend for the eval chain but were already charged to the provider.
    expect(f.factory.store.providerSpendSince("openrouter", 0)).toBeCloseTo(0.3);
    const report = f.factory.evals.report(resumed?.id ?? "");
    // Only the unfinished trial runs; the invalid output stays a failure instead of being re-billed.
    expect(f.calls.slice(calls).map((s) => s.prompt.includes("Fix c"))).toEqual([true]);
    expect(report?.trials.map((t) => [t.caseId, t.status, t.pass])).toEqual([
      ["a", "ok", true],
      ["b", "error", false],
      ["c", "ok", true],
    ]);
    expect(report?.trials[1]?.details.reason).toContain("Invalid triage output");
    expect(report?.summaries[0]?.passRate).toBeCloseTo(2 / 3);
    expect(f.factory.store.evalSpend(resumed?.id ?? "")).toBeCloseTo(0.3);
    expect(report?.run.status).toBe("budget_exhausted");
  } finally {
    await f.close();
  }
});

test("resume copies finished decision trials instead of running them again", async () => {
  const f = await evalFixture(
    [
      {
        id: "decider",
        provider: "decider-provider",
        model: "d",
        tier: 1,
        vendor: "other",
        origin: "unknown",
        baseOrigin: "unknown",
        supportedEfforts: [],
        price: { input: 1, output: 1 },
      },
    ],
    [{ id: "decider-provider", label: "D", harness: "decisions", billing: "subscription", maxConcurrent: 1 }],
  );
  try {
    const first = await interruptedAt(f, "b", () => ({ structured: answer }), { models: ["decider"] });
    expect(f.harnessNames).toEqual(["decisions", "decisions"]);
    const calls = f.calls.length;
    f.respond(() => ({ structured: answer }));
    const resumed = f.factory.evals.resume(first);
    await f.factory.evals.wait(resumed?.id ?? "");
    expect(f.calls.slice(calls).map((s) => s.prompt.includes("Fix a"))).toEqual([false, false]);
    expect(f.factory.evals.report(resumed?.id ?? "")?.trials.map((t) => t.status)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  } finally {
    await f.close();
  }
});

test("resume reruns a finished trial whose prompt changed and copies the unchanged ones", async () => {
  const f = await evalFixture();
  try {
    const first = await interruptedAt(f, "c", () => ({ structured: answer }));
    const changed = f.dataset.cases[0];
    if (!changed || !("prompt" in changed)) throw new Error("missing case");
    changed.prompt = "Fix a differently";
    f.save();
    const calls = f.calls.length;
    f.respond(() => ({ structured: answer }));
    const resumed = f.factory.evals.resume(first);
    await f.factory.evals.wait(resumed?.id ?? "");
    expect(f.calls.slice(calls).map((s) => s.prompt.match(/Fix \w+( differently)?/)?.[0])).toEqual([
      "Fix a differently",
      "Fix c",
    ]);
    const report = f.factory.evals.report(resumed?.id ?? "");
    expect(report?.trials.map((t) => [t.caseId, t.details.resumedFrom])).toEqual([
      ["a", undefined],
      ["b", first],
      ["c", undefined],
    ]);
    expect(formatEvalReport(report as EvalReport)).toContain(
      `resumed from ${first}: 1 trials copied, 2 run again`,
    );
  } finally {
    await f.close();
  }
});

test("resume reruns finished trials whose backend model changed behind the same catalog ID", async () => {
  const f = await evalFixture();
  try {
    const first = await interruptedAt(f, "b", () => ({ structured: answer }));
    const model = f.factory.router.model("candidate-a");
    if (!model) throw new Error("missing model");
    model.model = "a-new-checkpoint";
    const calls = f.calls.length;
    f.respond(() => ({ structured: answer }));
    const resumed = f.factory.evals.resume(first);
    await f.factory.evals.wait(resumed?.id ?? "");
    expect(f.calls.slice(calls).map((s) => s.target.model)).toEqual(Array(3).fill("a-new-checkpoint"));
    expect(f.factory.evals.report(resumed?.id ?? "")?.trials.some((t) => t.details.resumedFrom)).toBe(false);
  } finally {
    await f.close();
  }
});

test("resume regrades copied trials against the current labels without a model call", async () => {
  const f = await evalFixture();
  try {
    const first = await interruptedAt(f, "b", () => ({ structured: answer }));
    expect(f.factory.evals.report(first)?.trials[0]?.pass).toBe(true);
    const relabeled = f.dataset.cases[0];
    if (!relabeled || !("gold" in relabeled) || !("prompt" in relabeled)) throw new Error("missing case");
    relabeled.gold = { ...relabeled.gold, risk: "high" };
    f.save();
    const calls = f.calls.length;
    f.respond(() => ({ structured: answer }));
    const resumed = f.factory.evals.resume(first);
    await f.factory.evals.wait(resumed?.id ?? "");
    expect(f.calls.slice(calls).some((s) => s.prompt.includes("Fix a"))).toBe(false);
    expect(f.factory.evals.report(resumed?.id ?? "")?.trials[0]).toMatchObject({
      caseId: "a",
      pass: false,
      details: { resumedFrom: first, grade: { pass: false } },
    });
  } finally {
    await f.close();
  }
});

test("resume retries preparation failures instead of copying them", async () => {
  const f = await evalFixture();
  try {
    const first = await interruptedAt(f, "b", () => ({ structured: answer }));
    const failed = f.factory.evals.report(first)?.trials[0];
    if (!failed) throw new Error("missing trial");
    f.factory.store.recordEvalTrial({
      ...failed,
      status: "error",
      details: { ...failed.details, preparationFailed: true, reason: "missing pin" },
    });
    const calls = f.calls.length;
    f.respond(() => ({ structured: answer }));
    const resumed = f.factory.evals.resume(first);
    await f.factory.evals.wait(resumed?.id ?? "");
    expect(f.calls.slice(calls).some((s) => s.prompt.includes("Fix a"))).toBe(true);
    expect(f.factory.evals.report(resumed?.id ?? "")?.trials[0]).toMatchObject({ status: "ok", pass: true });
  } finally {
    await f.close();
  }
});
